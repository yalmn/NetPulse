// NetPulse Monitoring Dashboard
// Reine Oberfläche: Ziele, Messwerte und Länder-Checks kommen von der NetPulse-API auf dem VPS.
// Login per Basic-Auth-Header, gespeichert in sessionStorage (oder localStorage bei "Angemeldet bleiben").

const LS_AUTH = "netpulse-auth";
const LS_SERVER = "netpulse-server";
const LS_TAB = "netpulse-tab";
const LS_RANGE = "netpulse-geo-range";

const TYPE_LABEL = { http: "HTTP", https: "HTTPS", icmp: "Ping", geo: "Länder" };
const BLACKBOX_TYPES = ["http", "https", "icmp"];

// Kategoriale Slots 1 bis 3 (blau, orange, aqua), feste Reihenfolge je Land
const COUNTRY_PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a"],
  dark: ["#3987e5", "#d95926", "#199e70"],
};
const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

let config = {
  apiBase: "",
  grafanaPath: "/grafana/d/blackbox-monitoring-overview/?orgId=1&kiosk&refresh=30s",
  refreshSec: 15,
  countries: [
    { code: "DE", name: "Deutschland" },
    { code: "FR", name: "Frankreich" },
    { code: "JP", name: "Japan" },
  ],
};
let auth = null; // { server, user, token }
let statusData = { blackbox: {}, geo: [] };
let geoStatus = null;
let seriesCache = {}; // seriesCache[target] = Antwort von /api/geo/series
let activeTab = "monitoring";
let typesTouched = false;
let statusTimer = null;
let seriesTimer = null;

// ── DOM ──
const $ = (id) => document.getElementById(id);
const loginView = $("login-view");
const appView = $("app-view");
const loginForm = $("login-form");
const loginError = $("login-error");
const addForm = $("add-form");
const targetInput = $("target-input");
const addMsg = $("add-msg");
const geoBudget = $("geo-budget");
const typeBoxes = [...addForm.querySelectorAll('input[name="type"]')];
const connStatus = $("conn-status");
const geoRange = $("geo-range");
const grafanaFrame = $("grafana-frame");

// ── Helfer ──
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtMs = (ms) => (typeof ms === "number" ? Math.round(ms) + " ms" : "–");
const nowT = () => new Date().toLocaleTimeString("de-DE");
const hostOf = (t) => t.replace(/^https?:\/\//i, "").split("/")[0];
const isIp = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v) || (v.includes(":") && /^[0-9a-f:]+$/i.test(v));
const countryName = (code) => config.countries.find((c) => c.code === code)?.name || code;
const countryColor = (code) => {
  const idx = Math.max(0, config.countries.findIndex((c) => c.code === code));
  return (isDark() ? COUNTRY_PALETTE.dark : COUNTRY_PALETTE.light)[idx % 3];
};
const storage = () => (localStorage.getItem(LS_AUTH) ? localStorage : sessionStorage);
const serverUrl = () => auth.server.replace(/\/+$/, "");

function encodeBasic(user, password) {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return btoa(String.fromCharCode(...bytes));
}

function detailText(detail, status) {
  if (Array.isArray(detail)) return detail.map((d) => d.msg).join(", ");
  return detail || `Fehler ${status}`;
}

class AuthError extends Error {}

async function api(path, opts = {}, credentials = auth) {
  const headers = { Authorization: "Basic " + credentials.token };
  if (opts.body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(credentials.server.replace(/\/+$/, "") + path, { ...opts, headers });
  } catch (_) {
    throw new Error("Server nicht erreichbar");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(detailText(data.detail, 401));
  if (!res.ok) throw new Error(detailText(data.detail, res.status));
  return data;
}

function setConn(ok, text) {
  connStatus.textContent = text;
  connStatus.className = "meta " + (ok ? "ok" : "err");
}

// ── Login ──
function showLogin(message) {
  stopPolling();
  appView.hidden = true;
  loginView.hidden = false;
  $("logout-btn").hidden = true;
  $("user-info").textContent = "";
  connStatus.textContent = "";
  $("login-server").value = localStorage.getItem(LS_SERVER) || config.apiBase || "";
  loginError.hidden = !message;
  loginError.textContent = message || "";
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  $("logout-btn").hidden = false;
  $("user-info").textContent = auth.user;
  $("grafana-open").href = serverUrl() + config.grafanaPath.replace("&kiosk", "");
  selectTab(localStorage.getItem(LS_TAB) || "monitoring");
  startPolling();
}

function logout(message) {
  auth = null;
  localStorage.removeItem(LS_AUTH);
  sessionStorage.removeItem(LS_AUTH);
  grafanaFrame.removeAttribute("src");
  statusData = { blackbox: {}, geo: [] };
  seriesCache = {};
  showLogin(message);
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const server = $("login-server").value.trim();
  const user = $("login-user").value.trim();
  const credentials = { server, user, token: encodeBasic(user, $("login-password").value) };
  $("login-submit").disabled = true;
  loginError.hidden = true;
  try {
    await api("/api/me", {}, credentials);
    auth = credentials;
    localStorage.setItem(LS_SERVER, server);
    ($("login-remember").checked ? localStorage : sessionStorage).setItem(LS_AUTH, JSON.stringify(auth));
    $("login-password").value = "";
    showApp();
  } catch (err) {
    loginError.textContent = err instanceof AuthError ? "Benutzername oder Passwort falsch." : `${err.message}. Server-Adresse prüfen.`;
    loginError.hidden = false;
  } finally {
    $("login-submit").disabled = false;
  }
});

$("logout-btn").addEventListener("click", () => logout());

// ── Tabs ──
function selectTab(tab) {
  activeTab = tab === "geo" ? "geo" : "monitoring";
  localStorage.setItem(LS_TAB, activeTab);
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === activeTab)));
  document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.dataset.panel !== activeTab));
  // Grafana erst laden, wenn der Bereich sichtbar ist (sonst Login-Dialog ohne Kontext)
  if (activeTab === "monitoring" && !grafanaFrame.getAttribute("src")) grafanaFrame.src = serverUrl() + config.grafanaPath;
  if (activeTab === "geo") refreshSeries();
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));

// ── Ziel hinzufügen ──
function suggestTypes(value) {
  const v = value.trim();
  if (/^https:\/\//i.test(v)) return ["https"];
  if (/^http:\/\//i.test(v)) return ["http"];
  if (isIp(v)) return ["icmp"];
  return v ? ["https", "icmp"] : [];
}

function selectedTypes() {
  return typeBoxes.filter((b) => b.checked).map((b) => b.value);
}

targetInput.addEventListener("input", () => {
  if (typesTouched) return;
  const suggested = suggestTypes(targetInput.value);
  typeBoxes.forEach((b) => { if (b.value !== "geo") b.checked = suggested.includes(b.value); });
});
typeBoxes.forEach((b) => b.addEventListener("change", () => { typesTouched = true; renderBudget(); }));

function showAddMsg(text, ok) {
  addMsg.textContent = text;
  addMsg.className = "form-msg " + (ok ? "ok" : "err");
  addMsg.hidden = false;
}

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const types = selectedTypes();
  if (types.length === 0) { showAddMsg("Mindestens einen Check auswählen.", false); return; }
  $("add-target").disabled = true;
  try {
    const { results } = await api("/api/targets", { method: "POST", body: JSON.stringify({ target: targetInput.value, types }) });
    const added = results.filter((r) => r.added).map((r) => `${TYPE_LABEL[r.type]} ${r.target}`);
    const existing = results.filter((r) => !r.added).map((r) => TYPE_LABEL[r.type]);
    showAddMsg(
      (added.length ? `Hinzugefügt: ${added.join(", ")}.` : "") + (existing.length ? ` Bereits vorhanden: ${existing.join(", ")}.` : ""),
      added.length > 0
    );
    targetInput.value = "";
    typesTouched = false;
    typeBoxes.forEach((b) => (b.checked = false));
    await refreshStatus();
    if (activeTab === "geo") refreshSeries();
  } catch (err) {
    if (err instanceof AuthError) return logout("Sitzung abgelaufen, bitte neu anmelden.");
    showAddMsg(err.message, false);
  } finally {
    $("add-target").disabled = false;
  }
});

async function removeTarget(type, target, btn) {
  // Zweistufig statt Browser-Dialog: erster Klick fragt nach, zweiter entfernt
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Wirklich?";
    setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Entfernen"; }, 3000);
    return;
  }
  btn.disabled = true;
  try {
    await api(`/api/targets?type=${encodeURIComponent(type)}&target=${encodeURIComponent(target)}`, { method: "DELETE" });
    if (type === "geo") delete seriesCache[target];
    await refreshStatus();
    if (activeTab === "geo") renderGeo();
  } catch (err) {
    if (err instanceof AuthError) return logout("Sitzung abgelaufen, bitte neu anmelden.");
    showAddMsg(err.message, false);
    btn.disabled = false;
  }
}

// ── Daten laden ──
async function refreshStatus() {
  try {
    const [status, geo] = await Promise.all([api("/api/targets/status"), api("/api/geo/status")]);
    statusData = status;
    geoStatus = geo;
    setConn(true, "aktualisiert " + nowT());
    render();
  } catch (err) {
    if (err instanceof AuthError) return logout("Sitzung abgelaufen, bitte neu anmelden.");
    setConn(false, err.message);
  }
}

async function refreshSeries() {
  const range = geoRange.value;
  const targets = statusData.geo.map((g) => g.target);
  await Promise.all(
    targets.map(async (t) => {
      try {
        seriesCache[t] = await api(`/api/geo/series?target=${encodeURIComponent(t)}&range=${range}`);
      } catch (err) {
        if (err instanceof AuthError) throw err;
      }
    })
  ).catch((err) => { if (err instanceof AuthError) logout("Sitzung abgelaufen, bitte neu anmelden."); });
  if (auth) renderGeo();
}

function startPolling() {
  stopPolling();
  refreshStatus().then(() => { if (activeTab === "geo") refreshSeries(); });
  statusTimer = setInterval(refreshStatus, Math.max(5, config.refreshSec) * 1000);
  seriesTimer = setInterval(() => { if (activeTab === "geo") refreshSeries(); }, 60000);
}
function stopPolling() {
  clearInterval(statusTimer);
  clearInterval(seriesTimer);
}

geoRange.addEventListener("change", () => {
  localStorage.setItem(LS_RANGE, geoRange.value);
  seriesCache = {};
  refreshSeries();
});

// ── Rendering ──
function statusBadge(status, label) {
  const map = { up: "Online", down: "Offline", degraded: "Teilweise", unknown: "Ausstehend" };
  return `<span class="status-badge status-${status === "degraded" ? "warn" : status}"><span class="status-dot"></span>${esc(label || map[status] || status)}</span>`;
}

function geoState(entry) {
  const results = Object.values(entry.countries || {}).filter(Boolean);
  if (!entry.t || results.length === 0) return { status: "unknown", up: 0, total: config.countries.length, ms: null };
  const up = results.filter((r) => r.up).length;
  const ms = results.filter((r) => r.up && typeof r.ms === "number").map((r) => r.ms);
  return {
    status: up === results.length ? "up" : up === 0 ? "down" : "degraded",
    up,
    total: results.length,
    ms: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null,
  };
}

function allRows() {
  const rows = [];
  for (const type of BLACKBOX_TYPES) {
    for (const t of statusData.blackbox?.[type]?.targets || []) {
      rows.push({
        type,
        target: t.value,
        host: hostOf(t.value),
        status: t.status,
        ms: typeof t.probe_duration_seconds === "number" ? t.probe_duration_seconds * 1000 : null,
        availability: t.availability_5m,
      });
    }
  }
  for (const g of statusData.geo || []) {
    const s = geoState(g);
    rows.push({ type: "geo", target: g.target, host: hostOf(g.target), status: s.status, ms: s.ms, availability: null, geo: s });
  }
  const order = { http: 0, https: 1, icmp: 2, geo: 3 };
  return rows.sort((a, b) => a.host.localeCompare(b.host) || order[a.type] - order[b.type]);
}

function renderSummary() {
  const rows = allRows();
  const hosts = new Set(rows.map((r) => r.host)).size;
  const count = (s) => rows.filter((r) => r.status === s).length;
  const stat = (label, value, cls) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value ${cls || ""}">${value}</span></div>`;
  const takt = geoStatus && geoStatus.targets > 0 ? `${geoStatus.interval_s} s` : "–";
  $("summary").innerHTML =
    stat("Ziele", hosts) +
    stat("Checks online", count("up"), "ok") +
    stat("Teilweise", count("degraded"), count("degraded") ? "warn" : "") +
    stat("Offline", count("down"), count("down") ? "err" : "") +
    stat("Ausstehend", count("unknown")) +
    stat("Takt Länder-Check", takt);
}

function renderTargetTable() {
  const rows = allRows();
  const host = $("target-table");
  if (rows.length === 0) {
    host.innerHTML = '<div class="empty-state">Noch keine Ziele. Oben eine IP oder URL hinzufügen.</div>';
    return;
  }
  const body = rows
    .map((r) => {
      const detail = r.type === "geo" ? `${r.geo.up}/${r.geo.total} Länder` : r.availability != null ? r.availability + " %" : "–";
      return `<tr>
        <td class="country-target">${esc(r.target)}</td>
        <td>${TYPE_LABEL[r.type]}</td>
        <td>${statusBadge(r.status)}</td>
        <td class="num mono">${fmtMs(r.ms)}</td>
        <td class="num">${esc(detail)}</td>
        <td class="actions"><button class="btn btn-danger btn-sm" data-type="${r.type}" data-target="${esc(r.target)}">Entfernen</button></td>
      </tr>`;
    })
    .join("");
  host.innerHTML = `<div class="table-wrap"><table class="status-table">
    <thead><tr><th>Ziel</th><th>Check</th><th>Status</th><th class="num">Antwortzeit</th><th class="num">Verfügbarkeit</th><th></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
  host.querySelectorAll("button[data-type]").forEach((b) =>
    b.addEventListener("click", () => removeTarget(b.dataset.type, b.dataset.target, b))
  );
  $("targets-updated").textContent = "Verfügbarkeit: letzte 5 Minuten";
}

function renderBudget() {
  if (!geoStatus) { geoBudget.textContent = ""; return; }
  const n = geoStatus.targets;
  const wantsGeo = typeBoxes.find((b) => b.value === "geo").checked;
  const next = n + (wantsGeo ? 1 : 0);
  const perRound = geoStatus.countries.length || 3;
  const interval = next === 0 ? 60 : Math.max(60, Math.ceil((next * perRound * 3600) / (geoStatus.limit_per_hour * 0.9)));
  let text = `Länder-Check: ${n} ${n === 1 ? "Ziel" : "Ziele"} aktiv, bis zu ${geoStatus.max_minutely_targets} Ziele werden minütlich gemessen.`;
  if (wantsGeo) text += ` Mit diesem Ziel: alle ${interval} Sekunden.`;
  if (!geoStatus.token) text += " Ohne Globalping-Token gilt das kleinere anonyme Limit.";
  geoBudget.textContent = text;
  geoBudget.className = "hint" + (wantsGeo && interval > 60 ? " rate-over" : "");
}

function renderGeoStatus() {
  const el = $("geo-status");
  if (!geoStatus) { el.textContent = ""; return; }
  if (geoStatus.paused_for_s > 0) {
    el.textContent = `Globalping-Limit erreicht, weiter in ${Math.ceil(geoStatus.paused_for_s / 60)} min`;
    el.className = "meta err";
    return;
  }
  const quota = geoStatus.remaining != null ? `, Kontingent ${geoStatus.remaining}/${geoStatus.limit_per_hour}` : "";
  el.textContent = `alle ${geoStatus.interval_s} s${quota}`;
  el.className = "meta";
}

function renderGeo() {
  renderGeoStatus();
  const grid = $("geo-grid");
  const entries = statusData.geo || [];
  if (entries.length === 0) {
    grid.innerHTML = '<div class="card"><div class="empty-state">Noch keine Länder-Checks. Beim Hinzufügen eines Ziels „Länder-Check“ anhaken.</div></div>';
    return;
  }
  grid.innerHTML = "";
  for (const entry of entries) {
    const data = seriesCache[entry.target];
    const card = document.createElement("div");
    card.className = "card";
    const latest = config.countries
      .map((c) => {
        const r = entry.countries?.[c.code];
        const status = !r ? "unknown" : r.up ? "up" : "down";
        return `<span class="geo-now"><span class="legend-swatch" style="background:${countryColor(c.code)}"></span>${c.code} ${statusBadge(status, !r ? "–" : r.up ? fmtMs(r.ms) : r.code ? "HTTP " + r.code : "Offline")}</span>`;
      })
      .join("");
    card.innerHTML = `<div class="card-header-bar"><h3>${esc(entry.target)}</h3><div class="geo-latest">${latest}</div></div>
      <div class="card-body"><div class="chart-host"></div><div class="geo-stats"></div></div>`;
    grid.appendChild(card);

    const chartHost = card.querySelector(".chart-host");
    const statsHost = card.querySelector(".geo-stats");
    if (!data) { chartHost.innerHTML = '<div class="empty-state">Wird geladen …</div>'; continue; }

    const byCode = Object.fromEntries(data.countries.map((c) => [c.code, c]));
    const series = config.countries.map((c) => ({
      name: c.name,
      code: c.code,
      color: countryColor(c.code),
      values: byCode[c.code]?.values || [],
    }));
    const refLines = config.countries
      .filter((c) => typeof byCode[c.code]?.avg === "number")
      .map((c) => ({ v: byCode[c.code].avg, color: countryColor(c.code) }));
    NetPulseChart.line(chartHost, series, { unit: "ms", refLines });

    statsHost.innerHTML = config.countries
      .map((c) => {
        const d = byCode[c.code] || {};
        return `<div class="stat"><span class="stat-label"><span class="legend-swatch" style="background:${countryColor(c.code)}"></span>${esc(countryName(c.code))}</span>
          <span class="stat-value">Ø ${fmtMs(d.avg)}</span>
          <span class="meta">Verfügbarkeit ${typeof d.availability === "number" ? d.availability + " %" : "–"}</span></div>`;
      })
      .join("");
  }
}

function render() {
  renderSummary();
  renderTargetTable();
  renderBudget();
  if (activeTab === "geo") renderGeo();
  else renderGeoStatus();
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (auth) renderGeo(); });

// ── Init ──
async function init() {
  try { config = { ...config, ...(await (await fetch("config.json", { cache: "no-store" })).json()) }; } catch (_) {}
  const savedRange = localStorage.getItem(LS_RANGE);
  if (savedRange) geoRange.value = savedRange;
  try { auth = JSON.parse(localStorage.getItem(LS_AUTH) || sessionStorage.getItem(LS_AUTH)); } catch (_) { auth = null; }
  if (!auth?.token) return showLogin();
  try {
    await api("/api/me");
    showApp();
  } catch (err) {
    if (err instanceof AuthError) logout("Bitte neu anmelden.");
    else showLogin(`${err.message}. Server-Adresse prüfen.`);
  }
}

init();
