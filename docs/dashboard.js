// NetPulse Monitoring Dashboard
// Fuehrt HTTP-, HTTPS- und Ping-Checks direkt im Browser ueber Globalping aus und zeigt
// Status, Antwortzeit, Sparkline und Uptime je Ziel. Zusaetzlich ein Widget mit der
// Erreichbarkeit aus mehreren Laendern. Kein Server noetig. Wegen des freien Globalping
// Limits (250 Checks pro Stunde und IP) liegt das Intervall bei etwa 60 Sekunden.

const GLOBALPING = "https://api.globalping.io/v1/measurements";
const TYPES = ["http", "https", "ping"];
const TYPE_LABEL = { http: "HTTP", https: "HTTPS", ping: "Ping" };
const BUFFER = 60;         // gespeicherte Messpunkte je Ziel und Typ
const RATE_LIMIT = 250;    // freie Globalping-Tests pro Stunde und IP

const LS_TARGETS = "netpulse-dash-targets";
const LS_INTERVAL = "netpulse-dash-interval";

const PALETTE = {
  light: { http: "#2a78d6", https: "#1baf7a", ping: "#4a3aa7" },
  dark: { http: "#3987e5", https: "#199e70", ping: "#9085e9" },
};
const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const typeColor = (t) => (isDark() ? PALETTE.dark : PALETTE.light)[t];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowT = () => new Date().toLocaleTimeString("de-DE");
const hostOf = (target) => target.replace(/^https?:\/\//i, "").split("/")[0];

let config = { checkIntervalSec: 60, countryIntervalSec: 300, primaryCountry: "DE", defaultTargets: [], countries: [] };
let targets = [];
let intervalSec = 60;
let paused = false;
let store = {};        // store[target][type] = [{ t, ms, status, code }]
let countryStore = {}; // countryStore[target] = { code: { status, ms } }
let lastCountryAt = 0;
let checkTimer = null;
let checkBusy = false;
let countryBusy = false;

// ── DOM ──
const targetInput = document.getElementById("target-input");
const addTargetBtn = document.getElementById("add-target");
const intervalInput = document.getElementById("interval-input");
const rateEstimate = document.getElementById("rate-estimate");
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
  const buf = (store[target]?.[type] || []).filter((s) => s.status !== "unknown");
  if (buf.length === 0) return null;
  const up = buf.filter((s) => s.status === "up").length;
  return Math.round((up / buf.length) * 100);
}
function overallStatus(target) {
  const st = TYPES.map((t) => latest(target, t)?.status).filter((s) => s && s !== "unknown");
  if (st.length === 0) return "unknown";
  if (st.every((s) => s === "up")) return "up";
  if (st.every((s) => s === "down")) return "down";
  return "degraded";
}

// ── Rate-Schaetzung ──
function updateRateEstimate() {
  const n = targets.length;
  const mainPerHour = n * TYPES.length * (3600 / intervalSec);
  const countryPerHour = n * (config.countries.length || 0) * (3600 / config.countryIntervalSec);
  const total = Math.round(mainPerHour + countryPerHour);
  if (n === 0) { rateEstimate.textContent = "Noch keine Ziele."; return; }
  const over = total > RATE_LIMIT;
  rateEstimate.innerHTML =
    `Geschaetzt <strong>${total} Checks/Stunde</strong> (Haupt alle ${intervalSec}s, Laender alle ${config.countryIntervalSec}s). ` +
    (over
      ? `<span class="rate-over">Ueber dem freien Limit von ${RATE_LIMIT}/h. Intervall erhoehen oder weniger Ziele.</span>`
      : `Im freien Limit (${RATE_LIMIT}/h).`);
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
  updateRateEstimate();
  render();
  runCheckCycle();
  runCountryCycle(true);
}
function removeTarget(t) {
  targets = targets.filter((x) => x !== t);
  delete store[t];
  delete countryStore[t];
  saveTargets();
  updateRateEstimate();
  render();
}

// ── Globalping-Messung ──
// locations: [{ country }]; liefert je Standort { status, ms, code? }
async function gpMeasure(target, type, locations) {
  const isHttp = type === "http" || type === "https";
  const body = {
    target: hostOf(target),
    type: isHttp ? "http" : "ping",
    locations,
    measurementOptions: isHttp
      ? { protocol: type === "https" ? "HTTPS" : "HTTP", request: { method: "HEAD" } }
      : { packets: 2 },
  };
  const res = await fetch(GLOBALPING, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 429) throw new Error("429");
  if (!res.ok) throw new Error(String(res.status));
  const { id } = await res.json();
  const deadline = Date.now() + 30000;
  let data = null;
  while (Date.now() < deadline) {
    data = await (await fetch(`${GLOBALPING}/${id}`)).json();
    if (data.status !== "in-progress") break;
    await sleep(1000);
  }
  return locations.map((_, i) => {
    const r = (data?.results || [])[i]?.result || {};
    if (isHttp) {
      const code = r.statusCode;
      const ok = typeof code === "number" && code < 400;
      return { status: r.status === "failed" ? "down" : ok ? "up" : "down", ms: typeof r.timings?.total === "number" ? r.timings.total : null, code };
    }
    const s = r.stats || {};
    return { status: r.status === "failed" ? "down" : typeof s.loss === "number" ? (s.loss >= 100 ? "down" : "up") : "unknown", ms: typeof s.avg === "number" ? s.avg : null };
  });
}

async function runCheckCycle() {
  if (paused || checkBusy || targets.length === 0) return;
  checkBusy = true;
  const t = Date.now();
  const loc = [{ country: config.primaryCountry }];
  const tasks = [];
  for (const target of targets)
    for (const type of TYPES)
      tasks.push(gpMeasure(target, type, loc).then((arr) => ({ target, type, r: arr[0] })).catch((e) => ({ target, type, err: e.message })));
  const results = await Promise.all(tasks);
  let rateLimited = false;
  for (const res of results) {
    if (res.err) {
      if (res.err === "429") rateLimited = true;
      pushSample(res.target, res.type, { t, ms: null, status: "unknown" });
    } else {
      pushSample(res.target, res.type, { t, ms: res.r.ms, status: res.r.status, code: res.r.code });
    }
  }
  if (rateLimited) { connStatus.textContent = "Rate-Limit erreicht, Intervall erhoehen"; connStatus.className = "meta err"; }
  else { connStatus.textContent = "zuletzt geprueft " + nowT(); connStatus.className = "meta ok"; }
  checkBusy = false;
  render();
}

// ── Laender-Checks ──
async function runCountryCycle(force) {
  if (countryBusy || targets.length === 0 || config.countries.length === 0) return;
  if (!force && Date.now() - lastCountryAt < config.countryIntervalSec * 1000) return;
  countryBusy = true;
  const locs = config.countries.map((c) => ({ country: c.code }));
  try {
    for (const target of targets) {
      try {
        const arr = await gpMeasure(target, "ping", locs);
        const out = {};
        config.countries.forEach((c, i) => { out[c.code] = arr[i]; });
        countryStore[target] = out;
      } catch (_) { /* Ziel diesmal ueberspringen */ }
    }
    lastCountryAt = Date.now();
    countryUpdated.textContent = "aktualisiert " + nowT();
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
    stat("Intervall", intervalSec + "s");
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
    const head = document.createElement("div");
    head.className = "card-header-bar";
    head.innerHTML = `<h3>${target}</h3><div class="target-head-right">${statusBadge(overallStatus(target))}<button class="btn btn-danger" data-remove="${encodeURIComponent(target)}">Entfernen</button></div>`;
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

// ── Steuerung ──
function applyInterval() {
  const v = Math.max(30, parseInt(intervalInput.value, 10) || 60);
  intervalSec = v;
  localStorage.setItem(LS_INTERVAL, String(v));
  updateRateEstimate();
  renderSummary();
  clearInterval(checkTimer);
  checkTimer = setInterval(runCheckCycle, intervalSec * 1000);
}

addTargetBtn.addEventListener("click", () => addTarget(targetInput.value));
targetInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTarget(targetInput.value); });
intervalInput.addEventListener("change", applyInterval);
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
  intervalSec = Math.max(30, parseInt(localStorage.getItem(LS_INTERVAL), 10) || config.checkIntervalSec || 60);
  intervalInput.value = intervalSec;

  updateRateEstimate();
  render();

  runCheckCycle();
  checkTimer = setInterval(runCheckCycle, intervalSec * 1000);
  runCountryCycle(true);
  setInterval(() => runCountryCycle(false), 15000);
}

init();
