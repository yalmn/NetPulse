// NetPulse Monitoring Dashboard
// Fuehrt HTTP-, HTTPS- und Ping-Checks direkt im Browser ueber Globalping aus.
// Wichtig: Das freie Globalping-Limit liegt bei 250 Checks pro Stunde und IP. Deshalb
// werden die Checks automatisch getaktet (Token-Bucket), damit das Limit nie ueberschritten
// wird. Bei einem Limit wird kurz gedrosselt und danach automatisch weitergemacht.

const GLOBALPING = "https://api.globalping.io/v1/measurements";
const TYPES = ["http", "https", "ping"];
const TYPE_LABEL = { http: "HTTP", https: "HTTPS", ping: "Ping" };
const BUFFER = 60;         // gespeicherte Messpunkte je Ziel und Typ
const SAFE_RATE = 180;     // Checks pro Stunde, mit Abstand unter dem freien Limit von 250
const BACKOFF_MS = 45000;  // Drosselzeit nach einem Rate-Limit

const LS_TARGETS = "netpulse-dash-targets";

const PALETTE = {
  light: { http: "#2a78d6", https: "#1baf7a", ping: "#4a3aa7" },
  dark: { http: "#3987e5", https: "#199e70", ping: "#9085e9" },
};
const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const typeColor = (t) => (isDark() ? PALETTE.dark : PALETTE.light)[t];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowT = () => new Date().toLocaleTimeString("de-DE");
const hostOf = (target) => target.replace(/^https?:\/\//i, "").split("/")[0];

let config = { checkIntervalSec: 60, countryIntervalSec: 600, primaryCountry: "DE", defaultTargets: [], countries: [] };
let targets = [];
let paused = false;
let store = {};        // store[target][type] = [{ t, ms, status, code }]
let countryStore = {}; // countryStore[target] = { code: { status, ms } }
let lastCountryAt = 0;
let backoffUntil = 0;
let rateState = { remaining: null, resetAt: 0 }; // echtes Globalping-Kontingent aus den Response-Headern

// Token-Bucket: gibt pro Sekunde SAFE_RATE/3600 Tokens frei. Eine Messung an N Standorten
// kostet N Tokens. So bleibt die Summe aller Checks sicher unter dem freien Limit.
const bucket = {
  capacity: 6,
  tokens: 3,
  perSec: SAFE_RATE / 3600,
  last: Date.now(),
  refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
  },
  async take(n) {
    while (true) {
      this.refill();
      if (this.tokens >= n) { this.tokens -= n; return; }
      await sleep(500);
    }
  },
};

// ── DOM ──
const targetInput = document.getElementById("target-input");
const addTargetBtn = document.getElementById("add-target");
const rateInfo = document.getElementById("rate-estimate");
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

// ── Info zur automatischen Taktung ──
function updateRateInfo() {
  const n = targets.length;
  if (n === 0) { rateInfo.textContent = "Noch keine Ziele. Oben eine IP oder URL hinzufügen."; return; }
  const countryPerHour = n * (config.countries.length || 0) * (3600 / config.countryIntervalSec);
  const mainPerHour = Math.max(20, SAFE_RATE - countryPerHour);
  const mainJobs = n * TYPES.length;
  const refreshSec = Math.round((mainJobs * 3600) / mainPerHour);
  rateInfo.innerHTML =
    `Automatische Taktung, bleibt sicher unter dem freien Limit von 250 Checks/Stunde. ` +
    `Jedes Ziel wird etwa alle <strong>${refreshSec} Sekunden</strong> geprüft. ` +
    `Mehr Ziele bedeuten pro Ziel größere Abstände.`;
}

// Liest das echte Kontingent aus den Globalping-Headern (auch bei 429).
function syncRate(headers) {
  const rem = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (rem != null) rateState.remaining = parseInt(rem, 10);
  if (reset != null) rateState.resetAt = Date.now() + parseInt(reset, 10) * 1000;
  if (rateState.remaining != null && rateState.remaining <= 0) triggerBackoff();
}

function resetMinutes() {
  return Math.max(1, Math.ceil((rateState.resetAt - Date.now()) / 60000));
}

function setConn(kind) {
  if (kind === "limit") {
    connStatus.textContent = `Globalping-Kontingent aufgebraucht (0 von 250). Neues Kontingent in etwa ${resetMinutes()} Minuten, danach geht es automatisch weiter.`;
    connStatus.className = "meta err";
  } else {
    const budget = rateState.remaining != null ? `, Kontingent ${rateState.remaining} von 250` : "";
    connStatus.textContent = "zuletzt geprüft " + nowT() + budget;
    connStatus.className = "meta ok";
  }
}

function triggerBackoff() {
  const waitMs = rateState.resetAt > Date.now() ? rateState.resetAt - Date.now() : BACKOFF_MS;
  backoffUntil = Date.now() + Math.min(waitMs + 1000, 66 * 60 * 1000);
  bucket.tokens = 0;
  setConn("limit");
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
  updateRateInfo();
  render();
}
function removeTarget(t) {
  targets = targets.filter((x) => x !== t);
  delete store[t];
  delete countryStore[t];
  saveTargets();
  updateRateInfo();
  render();
}

// ── Globalping-Messung ──
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
  syncRate(res.headers);
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

// ── Schleife: Haupt-Checks (rundum, ein Job nach dem anderen, getaktet) ──
async function mainLoop() {
  let i = 0;
  while (true) {
    if (paused || targets.length === 0 || Date.now() < backoffUntil) { await sleep(1000); continue; }
    const jobs = targets.flatMap((t) => TYPES.map((ty) => ({ target: t, type: ty })));
    if (jobs.length === 0) { await sleep(1000); continue; }
    const job = jobs[i % jobs.length];
    i++;
    await bucket.take(1);
    if (Date.now() < backoffUntil) continue;
    try {
      const [r] = await gpMeasure(job.target, job.type, [{ country: config.primaryCountry }]);
      pushSample(job.target, job.type, { t: Date.now(), ms: r.ms, status: r.status, code: r.code });
      setConn("ok");
    } catch (e) {
      if (e.message === "429") triggerBackoff();
      else pushSample(job.target, job.type, { t: Date.now(), ms: null, status: "unknown" });
    }
    render();
  }
}

// ── Schleife: Laender-Erreichbarkeit ──
async function countryLoop() {
  while (true) {
    await sleep(2000);
    if (paused || targets.length === 0 || config.countries.length === 0) continue;
    if (Date.now() - lastCountryAt < config.countryIntervalSec * 1000) continue;
    if (Date.now() < backoffUntil) continue;
    const locs = config.countries.map((c) => ({ country: c.code }));
    for (const target of targets) {
      if (Date.now() < backoffUntil) break;
      await bucket.take(locs.length);
      try {
        const arr = await gpMeasure(target, "ping", locs);
        const out = {};
        config.countries.forEach((c, idx) => { out[c.code] = arr[idx]; });
        countryStore[target] = out;
      } catch (e) {
        if (e.message === "429") { triggerBackoff(); break; }
      }
    }
    lastCountryAt = Date.now();
    countryUpdated.textContent = "aktualisiert " + nowT();
    renderCountryWidget();
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
    stat("Ø Antwortzeit", avg != null ? avg + " ms" : "–");
}

function renderTargets() {
  if (targets.length === 0) {
    gridEl.innerHTML = '<div class="card"><div class="empty-state">Noch keine Ziele. Oben eine IP oder URL hinzufügen.</div></div>';
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
addTargetBtn.addEventListener("click", () => addTarget(targetInput.value));
targetInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTarget(targetInput.value); });
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "Fortsetzen" : "Pause";
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", render);

// ── Init ──
async function init() {
  try { config = { ...config, ...(await (await fetch("config.json", { cache: "no-store" })).json()) }; } catch (_) {}
  try { const t = JSON.parse(localStorage.getItem(LS_TARGETS)); if (Array.isArray(t)) targets = t; } catch (_) {}
  if (targets.length === 0 && Array.isArray(config.defaultTargets)) targets = [...config.defaultTargets];

  updateRateInfo();
  render();
  mainLoop();
  countryLoop();
  setInterval(() => { if (Date.now() < backoffUntil) setConn("limit"); }, 5000);
}

init();
