// NetPulse Daueraufnahme
// Nimmt fuer eingegebene IP/URLs fortlaufend Ping-, HTTP- und HTTPS-Messungen aus
// mehreren Laendern auf (via Globalping) und zeichnet Zeitverlauf + Erreichbarkeit,
// bis gestoppt wird. Laeuft komplett im Browser; Daten in localStorage (ueberleben Reload).

const API = "https://api.globalping.io/v1/measurements";
const STORAGE_KEY = "netpulse-monitor-session";
const MAX_SAMPLES = 600;
const RATE_LIMIT = 250; // freie Globalping-Tests pro Stunde und IP

const PALETTE = {
  light: ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"],
  dark: ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"],
};
const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const seriesColor = (i) => (isDark() ? PALETTE.dark : PALETTE.light)[i % 8];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numOrNull = (v) => (typeof v === "number" ? v : null);

const DEFAULT_COUNTRIES = [
  { code: "JP", name: "Japan" }, { code: "AU", name: "Australien" }, { code: "CA", name: "Kanada" },
  { code: "DE", name: "Deutschland" }, { code: "US", name: "USA" }, { code: "BR", name: "Brasilien" },
  { code: "IN", name: "Indien" }, { code: "ZA", name: "Suedafrika" }, { code: "SG", name: "Singapur" },
];
const TYPE_LABEL = { ping: "Ping-RTT", http: "HTTP-Antwortzeit", https: "HTTPS-Antwortzeit" };

// ── DOM ──
const setupEl = document.getElementById("setup");
const recordingEl = document.getElementById("recording");
const targetsInput = document.getElementById("targets-input");
const intervalInput = document.getElementById("interval-input");
const countryPicker = document.getElementById("country-picker");
const typeToggles = document.getElementById("type-toggles");
const rateEstimate = document.getElementById("rate-estimate");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const resetBtn = document.getElementById("reset-btn");
const recContent = document.getElementById("rec-content");
const sessionStats = document.getElementById("session-stats");
const recSubtitle = document.getElementById("rec-subtitle");

let session = null;
let cycleTimer = null;
let tickTimer = null;
let busy = false;

// ── Eingabe-Helfer ──
function parseTargets(text) {
  return [...new Set(text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}
function selectedCountries() {
  return [...countryPicker.querySelectorAll("input:checked")].map((i) => ({ code: i.value, name: i.dataset.name }));
}
function selectedTypes() {
  return [...typeToggles.querySelectorAll("input:checked")].map((i) => i.value);
}

function buildCountryPicker() {
  const preselect = new Set(["JP", "AU", "CA", "DE", "US"]);
  countryPicker.innerHTML =
    `<span class="picker-label">Laender:</span>` +
    DEFAULT_COUNTRIES.map(
      (c) => `<label class="chip"><input type="checkbox" value="${c.code}" data-name="${c.name}" ${preselect.has(c.code) ? "checked" : ""}/> ${c.name}</label>`
    ).join("");
}

function updateRateEstimate() {
  const n = parseTargets(targetsInput.value).length;
  const c = selectedCountries().length;
  const types = selectedTypes().length;
  const interval = Math.max(1, parseInt(intervalInput.value, 10) || 5);
  const perCycle = n * c * types;
  const perHour = Math.round(perCycle * (60 / interval));
  if (perCycle === 0) { rateEstimate.textContent = ""; return; }
  const over = perHour > RATE_LIMIT;
  rateEstimate.innerHTML =
    `Geschätzt <strong>${perHour} Tests/Stunde</strong> (${perCycle} pro Messung × ${(60 / interval).toFixed(1)}/h). ` +
    (over
      ? `<span style="color:var(--danger)">Über dem freien Limit von ${RATE_LIMIT}/h – Intervall erhöhen oder Länder/Ziele reduzieren.</span>`
      : `Innerhalb des freien Limits (${RATE_LIMIT}/h).`);
}

// ── Messung ──
async function measureOne(target, type, countries) {
  const isHttp = type === "http" || type === "https";
  const body = {
    target,
    type: isHttp ? "http" : "ping",
    locations: countries.map((c) => ({ country: c.code })),
    measurementOptions: isHttp
      ? { protocol: type === "https" ? "HTTPS" : "HTTP", request: { method: "HEAD" } }
      : { packets: 3 },
  };
  const perCountry = {};
  try {
    const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(String(res.status));
    const { id } = await res.json();
    const deadline = Date.now() + 30000;
    let data = null;
    while (Date.now() < deadline) {
      data = await (await fetch(`${API}/${id}`)).json();
      if (data.status !== "in-progress") break;
      await sleep(1000);
    }
    countries.forEach((c, i) => {
      const r = (data?.results || [])[i]?.result || {};
      if (isHttp) {
        const ok = typeof r.statusCode === "number" && r.statusCode < 400;
        perCountry[c.code] = { v: numOrNull(r.timings?.total), status: r.status === "failed" ? "down" : ok ? "up" : "down", code: r.statusCode };
      } else {
        const s = r.stats || {};
        const status = r.status === "failed" ? "down" : typeof s.loss === "number" ? (s.loss >= 100 ? "down" : "up") : "unknown";
        perCountry[c.code] = { v: numOrNull(s.avg), status, loss: s.loss };
      }
    });
  } catch (_) {
    countries.forEach((c) => { perCountry[c.code] = { v: null, status: "unknown" }; });
  }
  return perCountry;
}

async function runCycle() {
  if (busy || !session) return;
  busy = true;
  try {
    const t = Date.now();
    const tasks = [];
    for (const target of session.targets)
      for (const type of session.types)
        tasks.push(measureOne(target, type, session.countries).then((perCountry) => ({ target, type, perCountry })));
    const results = await Promise.all(tasks);

    const data = {};
    for (const { target, type, perCountry } of results) {
      (data[target] ||= {})[type] = perCountry;
    }
    session.samples.push({ t, data });
    if (session.samples.length > MAX_SAMPLES) session.samples = session.samples.slice(-MAX_SAMPLES);
    session.nextRunAt = Date.now() + session.intervalMs;
    save();
    renderRecording();
  } finally {
    busy = false;
  }
}

// ── Steuerung ──
function startSession() {
  const targets = parseTargets(targetsInput.value);
  const countries = selectedCountries();
  const types = selectedTypes();
  if (targets.length === 0) { targetsInput.focus(); return; }
  if (countries.length === 0) { rateEstimate.innerHTML = '<span style="color:var(--danger)">Bitte mindestens ein Land wählen.</span>'; return; }
  if (types.length === 0) { rateEstimate.innerHTML = '<span style="color:var(--danger)">Bitte mindestens eine Messung wählen.</span>'; return; }

  session = {
    targets, countries, types,
    intervalMs: Math.max(1, parseInt(intervalInput.value, 10) || 5) * 60000,
    startedAt: Date.now(),
    running: true,
    nextRunAt: Date.now(),
    samples: [],
  };
  save();
  showRecording();
  startTicker();
  runCycle();
  cycleTimer = setInterval(runCycle, session.intervalMs);
}

function stopSession() {
  if (!session) return;
  session.running = false;
  clearInterval(cycleTimer); cycleTimer = null;
  clearInterval(tickTimer); tickTimer = null;
  save();
  renderRecording();
  renderStats();
}

function resetSession() {
  clearInterval(cycleTimer); cycleTimer = null;
  clearInterval(tickTimer); tickTimer = null;
  session = null; busy = false;
  localStorage.removeItem(STORAGE_KEY);
  recordingEl.style.display = "none";
  setupEl.style.display = "";
  updateRateEstimate();
}

function resumeSession() {
  showRecording();
  renderRecording();
  if (session.running) {
    startTicker();
    const delay = Math.max(0, (session.nextRunAt || 0) - Date.now());
    setTimeout(() => {
      if (!session || !session.running) return;
      runCycle();
      cycleTimer = setInterval(runCycle, session.intervalMs);
    }, delay);
  }
}

function startTicker() {
  clearInterval(tickTimer);
  tickTimer = setInterval(renderStats, 1000);
  renderStats();
}

function showRecording() {
  setupEl.style.display = "none";
  recordingEl.style.display = "";
  recSubtitle.textContent = session.targets.join(", ");
}

// ── Persistenz ──
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); }
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && Array.isArray(s.targets) && Array.isArray(s.samples)) return s;
  } catch (_) {}
  return null;
}

// ── Rendering ──
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function renderStats() {
  if (!session) return;
  const now = Date.now();
  const perCycle = session.targets.length * session.countries.length * session.types.length;
  const perHour = Math.round(perCycle * (60 / (session.intervalMs / 60000)));
  const stat = (label, value) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`;
  const statusDot = session.running
    ? '<span class="status-badge status-up"><span class="status-dot"></span>Läuft</span>'
    : '<span class="status-badge status-unknown"><span class="status-dot"></span>Gestoppt</span>';
  sessionStats.innerHTML =
    stat("Status", statusDot) +
    stat("Ziele", session.targets.length) +
    stat("Gestartet", new Date(session.startedAt).toLocaleTimeString("de-DE")) +
    stat("Laufzeit", fmtDuration(now - session.startedAt)) +
    stat("Messpunkte", session.samples.length) +
    stat("Intervall", session.intervalMs / 60000 + " min") +
    (session.running ? stat("Nächste in", fmtCountdown((session.nextRunAt || now) - now)) : "") +
    stat("Tests/h", perHour);
}

function reachabilityRows(target) {
  const primary = session.types.includes("ping") ? "ping" : session.types[0];
  return session.countries.map((c) => ({
    name: c.name,
    cells: session.samples.map((s) => {
      const cell = s.data[target]?.[primary]?.[c.code];
      const status = cell?.status || "unknown";
      return { t: s.t, status, title: `${new Date(s.t).toLocaleString("de-DE")} – ${c.name}: ${status}` };
    }),
  }));
}

function buildSeries(target, type) {
  return session.countries.map((c, i) => ({
    name: c.name,
    code: c.code,
    color: seriesColor(i),
    values: session.samples.map((s) => ({ t: s.t, v: numOrNull(s.data[target]?.[type]?.[c.code]?.v) })),
  }));
}

function renderRecording() {
  renderStats();
  recContent.innerHTML = "";
  for (const target of session.targets) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-header-bar"><h3>${target}</h3></div>`;

    const body = document.createElement("div");
    body.className = "card-body";

    // Erreichbarkeit
    const upWrap = document.createElement("div");
    upWrap.className = "chart-block-inner";
    upWrap.innerHTML = `<div class="chart-title">Erreichbarkeit pro Land
      <span class="uptime-legend"><span class="uptime-cell uptime-up"></span>erreichbar
      <span class="uptime-cell uptime-down"></span>Ausfall
      <span class="uptime-cell uptime-unknown"></span>unbekannt</span></div><div class="uptime-host"></div>`;
    body.appendChild(upWrap);
    NetPulseChart.uptime(upWrap.querySelector(".uptime-host"), reachabilityRows(target));

    // Metriken
    for (const type of session.types) {
      const block = document.createElement("div");
      block.className = "chart-block-inner";
      block.innerHTML = `<div class="chart-title">${TYPE_LABEL[type]}</div><div class="chart-host"></div>`;
      body.appendChild(block);
      NetPulseChart.line(block.querySelector(".chart-host"), buildSeries(target, type), { unit: "ms" });
    }

    card.appendChild(body);
    recContent.appendChild(card);
  }
}

// ── Init ──
buildCountryPicker();
[targetsInput, intervalInput].forEach((e) => e.addEventListener("input", updateRateEstimate));
countryPicker.addEventListener("change", updateRateEstimate);
typeToggles.addEventListener("change", updateRateEstimate);
startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
resetBtn.addEventListener("click", resetSession);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (session) renderRecording(); });

updateRateEstimate();
session = load();
if (session) resumeSession();
