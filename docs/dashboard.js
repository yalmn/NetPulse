// NetPulse Monitoring Dashboard
// Fragt einen eigenen Cloudflare-Worker alle 10 Sekunden fuer HTTP, HTTPS und Ping ab
// und zeigt Status, Antwortzeit, Sparkline und Uptime je Ziel. Zusaetzlich ein Widget
// mit der Erreichbarkeit aus mehreren Laendern via Globalping.

const GLOBALPING = "https://api.globalping.io/v1/measurements";
const TYPES = ["http", "https", "ping"];
const TYPE_LABEL = { http: "HTTP", https: "HTTPS", ping: "Ping" };
const BUFFER = 60; // gespeicherte Messpunkte je Ziel/Typ (10 Minuten bei 10s)

const LS_TARGETS = "netpulse-dash-targets";
const LS_WORKER = "netpulse-dash-worker";

const PALETTE = {
  light: { http: "#2a78d6", https: "#1baf7a", ping: "#4a3aa7" },
  dark: { http: "#3987e5", https: "#199e70", ping: "#9085e9" },
};
const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const typeColor = (t) => (isDark() ? PALETTE.dark : PALETTE.light)[t];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toLocaleTimeString("de-DE");

let config = { checkIntervalSec: 10, countryIntervalSec: 120, defaultTargets: [], countries: [] };
let targets = [];
let workerUrl = "";
let paused = false;
let store = {};        // store[target][type] = [{ t, ms, status, code }]
let countryStore = {}; // countryStore[target] = { code: { status, ms, loss } }
let lastCountryAt = 0;
let checkTimer = null;
let countryBusy = false;

// ── DOM ──
const targetInput = document.getElementById("target-input");
const addTargetBtn = document.getElementById("add-target");
const workerInput = document.getElementById("worker-url");
const saveWorkerBtn = document.getElementById("save-worker");
const workerHint = document.getElementById("worker-hint");
const summaryEl = document.getElementById("summary");
const gridEl = document.getElementById("targets-grid");
const countryWidget = document.getElementById("country-widget");
const countryUpdated = document.getElementById("country-updated");
const connStatus = document.getElementById("conn-status");
const pauseBtn = document.getElementById("pause-btn");

// ── Helfer ──
const fmtMs = (ms) => (typeof ms === "number" ? Math.round(ms) + " ms" : "–");

function ensureStore(target) {
  if (!store[target]) store[target] = { http: [], https: [], ping: [] };
}
function pushSample(target, type, sample) {
  ensureStore(target);
  const buf = store[target][type];
  buf.push(sample);
  if (buf.length > BUFFER) buf.shift();
}
function latest(target, type) {
  const buf = store[target]?.[type];
  return buf && buf.length ? buf[buf.length - 1] : null;
}
function uptimePct(target, type) {
  const buf = store[target]?.[type] || [];
  if (buf.length === 0) return null;
  const up = buf.filter((s) => s.status === "up").length;
  return Math.round((up / buf.length) * 100);
}
function overallStatus(target) {
  const st = TYPES.map((t) => latest(target, t)?.status).filter(Boolean);
  if (st.length === 0) return "unknown";
  if (st.every((s) => s === "up")) return "up";
  if (st.every((s) => s === "down")) return "down";
  return "degraded";
}

// ── Persistenz ──
function saveTargets() { localStorage.setItem(LS_TARGETS, JSON.stringify(targets)); }

// ── Zieleingabe ──
function addTarget(raw) {
  const t = String(raw || "").trim();
  if (!t) return;
  if (targets.includes(t)) { targetInput.value = ""; return; }
  targets.push(t);
  saveTargets();
  targetInput.value = "";
  render();
  runCheckCycle();
  runCountryCycle(true);
}
function removeTarget(t) {
  targets = targets.filter((x) => x !== t);
  delete store[t];
  delete countryStore[t];
  saveTargets();
  render();
}

// ── Worker-Checks ──
async function runCheckCycle() {
  if (paused || targets.length === 0) return;
  if (!workerUrl) { setWorkerHint(); return; }
  try {
    const res = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets, types: TYPES }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const t = Date.now();
    for (const r of data.results || []) {
      pushSample(r.target, r.type, { t, ms: typeof r.ms === "number" ? r.ms : null, status: r.status, code: r.code });
    }
    connStatus.textContent = "Worker verbunden, zuletzt " + nowIso();
    connStatus.className = "meta ok";
  } catch (err) {
    connStatus.textContent = "Worker nicht erreichbar (" + err.message + ")";
    connStatus.className = "meta err";
  }
  render();
}

// ── Laender-Checks via Globalping ──
async function measureCountry(target) {
  const body = {
    target: target.replace(/^https?:\/\//i, "").split("/")[0],
    type: "ping",
    locations: config.countries.map((c) => ({ country: c.code })),
    measurementOptions: { packets: 2 },
  };
  const res = await fetch(GLOBALPING, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(String(res.status));
  const { id } = await res.json();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const data = await (await fetch(`${GLOBALPING}/${id}`)).json();
    if (data.status !== "in-progress") {
      const out = {};
      config.countries.forEach((c, i) => {
        const r = (data.results || [])[i]?.result || {};
        const s = r.stats || {};
        out[c.code] = {
          status: r.status === "failed" ? "down" : typeof s.loss === "number" ? (s.loss >= 100 ? "down" : "up") : "unknown",
          ms: typeof s.avg === "number" ? s.avg : null,
        };
      });
      return out;
    }
    await sleep(1000);
  }
  throw new Error("Zeitueberschreitung");
}

async function runCountryCycle(force) {
  if (countryBusy || targets.length === 0) return;
  if (!force && Date.now() - lastCountryAt < config.countryIntervalSec * 1000) return;
  countryBusy = true;
  try {
    for (const target of targets) {
      try { countryStore[target] = await measureCountry(target); }
      catch (_) { /* Ziel diesmal ueberspringen */ }
    }
    lastCountryAt = Date.now();
    countryUpdated.textContent = "aktualisiert " + nowIso();
    renderCountryWidget();
  } finally {
    countryBusy = false;
  }
}

// ── Rendering ──
function statusBadge(status, label) {
  const map = { up: "Online", down: "Offline", degraded: "Teilweise", unknown: "–" };
  return `<span class="status-badge status-${status === "degraded" ? "warn" : status}"><span class="status-dot"></span>${label || map[status] || status}</span>`;
}

function renderSummary() {
  const online = targets.filter((t) => overallStatus(t) === "up").length;
  const offline = targets.filter((t) => overallStatus(t) === "down").length;
  const degraded = targets.filter((t) => overallStatus(t) === "degraded").length;
  const allMs = [];
  for (const t of targets) for (const ty of TYPES) { const l = latest(t, ty); if (l && l.status === "up" && typeof l.ms === "number") allMs.push(l.ms); }
  const avg = allMs.length ? Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length) : null;
  const stat = (label, value, cls) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value ${cls || ""}">${value}</span></div>`;
  summaryEl.innerHTML =
    stat("Ziele", targets.length) +
    stat("Online", online, "ok") +
    stat("Teilweise", degraded, degraded ? "warn" : "") +
    stat("Offline", offline, offline ? "err" : "") +
    stat("Ø Antwortzeit", avg != null ? avg + " ms" : "–") +
    stat("Intervall", config.checkIntervalSec + "s");
}

function renderTargets() {
  if (targets.length === 0) {
    gridEl.innerHTML = '<div class="card"><div class="empty-state">Noch keine Ziele. Oben eine IP oder URL hinzufuegen.</div></div>';
    return;
  }
  gridEl.innerHTML = "";
  for (const target of targets) {
    const card = document.createElement("div");
    card.className = "card target-card";
    const ov = overallStatus(target);
    const head = document.createElement("div");
    head.className = "card-header-bar";
    head.innerHTML = `<h3>${target}</h3><div class="target-head-right">${statusBadge(ov)}<button class="btn btn-danger" data-remove="${encodeURIComponent(target)}">Entfernen</button></div>`;
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "card-body checks";
    for (const type of TYPES) {
      const l = latest(target, type);
      const row = document.createElement("div");
      row.className = "check-row";
      const up = uptimePct(target, type);
      row.innerHTML =
        `<span class="check-name">${TYPE_LABEL[type]}</span>` +
        statusBadge(l?.status || "unknown") +
        `<span class="mono check-code">${l?.code != null ? l.code : ""}</span>` +
        `<span class="mono check-ms">${fmtMs(l?.ms)}</span>` +
        `<span class="check-uptime">${up != null ? up + "%" : "–"}</span>` +
        `<div class="spark-host"></div>`;
      body.appendChild(row);
      const points = (store[target]?.[type] || []).map((s) => ({ v: s.ms, status: s.status }));
      NetPulseChart.spark(row.querySelector(".spark-host"), points, { color: typeColor(type) });
    }
    card.appendChild(body);
    gridEl.appendChild(card);
  }
  gridEl.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => removeTarget(decodeURIComponent(b.dataset.remove)))
  );
}

function renderCountryWidget() {
  if (targets.length === 0) { countryWidget.innerHTML = '<div class="empty-state">Wird geladen, sobald Ziele vorhanden sind.</div>'; return; }
  const cols = config.countries;
  const head = `<tr><th>Ziel</th>${cols.map((c) => `<th>${c.name}</th>`).join("")}</tr>`;
  const rows = targets
    .map((t) => {
      const cells = cols
        .map((c) => {
          const cell = countryStore[t]?.[c.code];
          if (!cell) return `<td><span class="mono">…</span></td>`;
          return `<td>${statusBadge(cell.status)}<span class="mono country-ms">${cell.ms != null ? Math.round(cell.ms) + " ms" : ""}</span></td>`;
        })
        .join("");
      return `<tr><td class="country-target">${t}</td>${cells}</tr>`;
    })
    .join("");
  countryWidget.innerHTML = `<div class="table-wrap"><table class="status-table country-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function render() {
  renderSummary();
  renderTargets();
  renderCountryWidget();
}

function setWorkerHint() {
  if (workerUrl) {
    workerHint.innerHTML = "Worker gesetzt. Checks laufen alle " + config.checkIntervalSec + " Sekunden.";
    workerHint.className = "hint";
  } else {
    workerHint.innerHTML = 'Kein Worker gesetzt. HTTP, HTTPS und Ping brauchen den Cloudflare-Worker. Anleitung liegt im Ordner <span class="mono">worker/</span>. URL oben eintragen und speichern.';
    workerHint.className = "hint";
  }
}

// ── Steuerung ──
addTargetBtn.addEventListener("click", () => addTarget(targetInput.value));
targetInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTarget(targetInput.value); });
saveWorkerBtn.addEventListener("click", () => {
  workerUrl = workerInput.value.trim().replace(/\/+$/, "");
  localStorage.setItem(LS_WORKER, workerUrl);
  setWorkerHint();
  runCheckCycle();
});
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "Fortsetzen" : "Pause";
  if (!paused) runCheckCycle();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", render);

// ── Init ──
async function init() {
  try { config = { ...config, ...(await (await fetch("config.json", { cache: "no-store" })).json()) }; } catch (_) {}
  try { const t = JSON.parse(localStorage.getItem(LS_TARGETS)); if (Array.isArray(t)) targets = t; } catch (_) {}
  if (targets.length === 0 && Array.isArray(config.defaultTargets)) targets = [...config.defaultTargets];
  workerUrl = (localStorage.getItem(LS_WORKER) || config.workerUrl || "").replace(/\/+$/, "");
  workerInput.value = workerUrl;
  setWorkerHint();
  render();

  runCheckCycle();
  checkTimer = setInterval(runCheckCycle, config.checkIntervalSec * 1000);
  runCountryCycle(true);
  setInterval(() => runCountryCycle(false), 15000);
}

init();
