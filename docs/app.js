// NetPulse Status-Seite
// - rendert docs/data/status.json (Momentaufnahme) + docs/data/history.json (Verlauf als Liniendiagramm)
// - erlaubt ad-hoc Live-Messungen (Ping/HTTP/HTTPS) direkt gegen die Globalping-API (CORS aktiv)

const API = "https://api.globalping.io/v1/measurements";
const SVG_NS = "http://www.w3.org/2000/svg";

const content = document.getElementById("content");
const lastUpdated = document.getElementById("last-updated");

let config = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, unit = "") => (typeof n === "number" ? n.toFixed(1) + unit : "–");
const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

// Validierte kategorische Palette (dataviz-Skill), Slots 1..8, Reihenfolge fest.
const PALETTE = {
  light: ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"],
  dark: ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"],
};
const seriesColor = (i) => (isDark() ? PALETTE.dark : PALETTE.light)[i % 8];

// ── Statusdarstellung ──
function statusBadge(status) {
  const label = status === "up" ? "Erreichbar" : status === "down" ? "Ausfall" : "Unbekannt";
  return `<span class="status-badge status-${status}"><span class="status-dot"></span>${label}</span>`;
}
function rttCell(avg) {
  if (typeof avg !== "number") return '<span class="mono">–</span>';
  const warn = config && avg > (config.latencyWarnMs || Infinity);
  return `<span class="mono ${warn ? "rtt-warn" : ""}">${fmt(avg)} ms</span>`;
}

function statusTable(results) {
  const rows = (results || [])
    .map(
      (r) => `
      <tr>
        <td><div class="country-cell"><span class="country-name">${r.name || r.country}</span>
          <span class="country-sub">${[r.city, r.network].filter(Boolean).join(" · ") || r.country}</span></div></td>
        <td>${statusBadge(r.status)}</td>
        <td>${rttCell(r.avg)}</td>
        <td><span class="mono">${fmt(r.min, " ms")}</span></td>
        <td><span class="mono">${fmt(r.max, " ms")}</span></td>
        <td><span class="mono">${r.loss != null ? r.loss + " %" : "–"}</span></td>
      </tr>`
    )
    .join("");
  return `<div class="table-wrap"><table class="status-table">
      <thead><tr><th>Standort</th><th>Status</th><th>Ø RTT</th><th>Min</th><th>Max</th><th>Verlust</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// ── Momentaufnahme + Verlauf pro Ziel rendern ──
function renderTargets(statusTargets, history) {
  if (!statusTargets || statusTargets.length === 0) {
    content.innerHTML = '<div class="card"><div class="empty-state">Noch keine Messdaten vorhanden.</div></div>';
    return;
  }
  content.innerHTML = "";
  for (const t of statusTargets) {
    const card = document.createElement("div");
    card.className = "card";
    const err = t.error ? `<div class="empty-state" style="color:var(--danger)">Fehler: ${t.error}</div>` : "";
    card.innerHTML = `
      <div class="card-header-bar"><h3>${t.target}</h3></div>
      ${err}
      ${statusTable(t.results)}
      <div class="chart-block"><div class="chart-title">Latenz (Ø RTT) im Zeitverlauf</div>
        <div class="chart-host"></div></div>`;
    content.appendChild(card);
    renderHistoryChart(card.querySelector(".chart-host"), t, history);
  }
}

// ── Liniendiagramm (SVG, eine Linie pro Land) ──
function buildSeries(target, history) {
  const points = (history && history.points) || [];
  const countries = (config && config.countries) || [];
  const list = countries.length
    ? countries.map((c) => ({ code: c.code, name: c.name || c.code }))
    : // Fallback: Laender aus der Historie ableiten
      Object.keys((points.at(-1)?.data || {})[target] || {}).map((code) => ({ code, name: code }));

  return list.map((c, i) => ({
    code: c.code,
    name: c.name,
    color: seriesColor(i),
    values: points
      .map((p) => {
        const v = p.data?.[target]?.[c.code];
        return typeof v === "number" ? { t: new Date(p.t).getTime(), v } : { t: new Date(p.t).getTime(), v: null };
      }),
  }));
}

function niceMax(v) {
  if (!(v > 0)) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * pow;
}

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
  if (text != null) e.textContent = text;
  return e;
}

function fmtTime(ms, withDate) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return withDate ? d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) + " " + time : time;
}

function renderHistoryChart(host, target, history) {
  const series = buildSeries(target.target, history);
  const tAll = ((history && history.points) || []).map((p) => new Date(p.t).getTime());
  if (tAll.length === 0) {
    host.innerHTML = '<div class="empty-state">Noch keine Verlaufsdaten – der geplante Job sammelt sie automatisch.</div>';
    return;
  }

  const W = 760, H = 240;
  const m = { top: 12, right: 76, bottom: 26, left: 46 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;

  const tMin = Math.min(...tAll), tMax = Math.max(...tAll);
  const tSpan = tMax - tMin || 1;
  const withDate = tSpan > 24 * 3600 * 1000;
  let maxV = 0;
  for (const s of series) for (const p of s.values) if (typeof p.v === "number") maxV = Math.max(maxV, p.v);
  const yMax = niceMax(maxV);

  const xOf = (t) => m.left + ((t - tMin) / tSpan) * pw;
  const yOf = (v) => m.top + ph - (v / yMax) * ph;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "line-chart", role: "img" });

  // Gridlines + Y-Achse
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (yMax / ticks) * i;
    const y = yOf(v);
    svg.appendChild(el("line", { x1: m.left, y1: y, x2: m.left + pw, y2: y, class: "grid" }));
    svg.appendChild(el("text", { x: m.left - 8, y: y + 3, class: "axis-label", "text-anchor": "end" }, Math.round(v) + ""));
  }
  // X-Achse: Start / Mitte / Ende
  for (const t of [tMin, tMin + tSpan / 2, tMax]) {
    svg.appendChild(el("text", { x: xOf(t), y: H - 8, class: "axis-label", "text-anchor": "middle" }, fmtTime(t, withDate)));
  }
  svg.appendChild(el("text", { x: 4, y: m.top + 4, class: "axis-label", "text-anchor": "start" }, "ms"));

  // Linien (Luecken bei null segmentieren) + Endpunkt-Label (mit Kollisionsvermeidung)
  const endLabels = [];
  for (const s of series) {
    let seg = [];
    const flush = () => {
      if (seg.length === 1) svg.appendChild(el("circle", { cx: xOf(seg[0].t), cy: yOf(seg[0].v), r: 2.5, fill: s.color }));
      else if (seg.length > 1)
        svg.appendChild(el("polyline", { points: seg.map((p) => `${xOf(p.t)},${yOf(p.v)}`).join(" "), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      seg = [];
    };
    for (const p of s.values) (typeof p.v === "number" ? seg.push(p) : flush());
    flush();
    const last = [...s.values].reverse().find((p) => typeof p.v === "number");
    if (last) {
      svg.appendChild(el("circle", { cx: xOf(last.t), cy: yOf(last.v), r: 3, fill: s.color }));
      endLabels.push({ code: s.code, color: s.color, y: yOf(last.v) });
    }
  }
  // Labels vertikal entzerren (min. 11px Abstand) und farbigen Punkt als Identitaetsmarke setzen
  endLabels.sort((a, b) => a.y - b.y);
  const gap = 11;
  for (let i = 1; i < endLabels.length; i++)
    if (endLabels[i].y - endLabels[i - 1].y < gap) endLabels[i].y = endLabels[i - 1].y + gap;
  const shift = Math.max(0, (endLabels.at(-1)?.y || 0) - (m.top + ph));
  for (const lbl of endLabels) {
    const ly = lbl.y - shift;
    svg.appendChild(el("rect", { x: m.left + pw + 6, y: ly - 6, width: 6, height: 6, rx: 1, fill: lbl.color }));
    svg.appendChild(el("text", { x: m.left + pw + 16, y: ly, class: "end-label" }, lbl.code));
  }

  // Hover-Crosshair
  const crosshair = el("line", { class: "crosshair", y1: m.top, y2: m.top + ph, x1: -10, x2: -10, visibility: "hidden" });
  svg.appendChild(crosshair);
  const dots = series.map((s) => {
    const c = el("circle", { r: 3.5, fill: s.color, stroke: isDark() ? "#1e293b" : "#fff", "stroke-width": 1.5, visibility: "hidden" });
    svg.appendChild(c);
    return c;
  });
  const capture = el("rect", { x: m.left, y: m.top, width: pw, height: ph, fill: "transparent" });
  svg.appendChild(capture);

  host.innerHTML = "";
  host.appendChild(svg);

  // Legende
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML = series
    .map((s) => `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.name}</span>`)
    .join("");
  host.appendChild(legend);

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.style.display = "none";
  host.appendChild(tip);

  const nearestIndex = (t) => {
    let best = 0, bd = Infinity;
    tAll.forEach((tv, i) => { const d = Math.abs(tv - t); if (d < bd) { bd = d; best = i; } });
    return best;
  };

  function onMove(evt) {
    const rect = svg.getBoundingClientRect();
    const sx = W / rect.width;
    const px = (evt.clientX - rect.left) * sx;
    const t = tMin + ((px - m.left) / pw) * tSpan;
    const idx = nearestIndex(t);
    const tv = tAll[idx];
    const cx = xOf(tv);
    crosshair.setAttribute("x1", cx); crosshair.setAttribute("x2", cx); crosshair.setAttribute("visibility", "visible");
    const rows = [];
    series.forEach((s, i) => {
      const p = s.values[idx];
      if (p && typeof p.v === "number") {
        dots[i].setAttribute("cx", cx); dots[i].setAttribute("cy", yOf(p.v)); dots[i].setAttribute("visibility", "visible");
        rows.push(`<div class="tip-row"><span class="legend-swatch" style="background:${s.color}"></span><span>${s.name}</span><span class="tip-val">${fmt(p.v)} ms</span></div>`);
      } else dots[i].setAttribute("visibility", "hidden");
    });
    tip.innerHTML = `<div class="tip-time">${fmtTime(tv, true)}</div>${rows.join("")}`;
    tip.style.display = "block";
    const left = Math.min((cx / W) * rect.width + 12, rect.width - tip.offsetWidth - 8);
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = "8px";
  }
  function onLeave() {
    crosshair.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    tip.style.display = "none";
  }
  capture.addEventListener("mousemove", onMove);
  capture.addEventListener("mouseleave", onLeave);
}

function setUpdated(iso) {
  lastUpdated.textContent = iso ? "Stand: " + new Date(iso).toLocaleString("de-DE") : "Keine Daten";
}

// ── Laden ──
async function loadStatic() {
  try {
    config = await (await fetch("config.json", { cache: "no-store" })).json();
    document.getElementById("page-title").textContent = config.title || "Globale Erreichbarkeit";
  } catch (_) {}
  buildCountryPicker();
  let history = { points: [] };
  try { history = await (await fetch("data/history.json", { cache: "no-store" })).json(); } catch (_) {}
  try {
    const data = await (await fetch("data/status.json", { cache: "no-store" })).json();
    renderTargets(data.targets, history);
    setUpdated(data.generatedAt);
  } catch (_) {
    content.innerHTML = '<div class="card"><div class="empty-state">status.json konnte nicht geladen werden.</div></div>';
    setUpdated(null);
  }
}

// ── Interaktive Schnellpruefung ──
const probeForm = document.getElementById("probe-form");
const probeTarget = document.getElementById("probe-target");
const probeType = document.getElementById("probe-type");
const probeBtn = document.getElementById("probe-btn");
const probeResult = document.getElementById("probe-result");
const countryPicker = document.getElementById("country-picker");

const DEFAULT_COUNTRIES = [
  { code: "JP", name: "Japan" }, { code: "AU", name: "Australien" }, { code: "CA", name: "Kanada" },
  { code: "DE", name: "Deutschland" }, { code: "US", name: "USA" }, { code: "BR", name: "Brasilien" },
  { code: "IN", name: "Indien" }, { code: "ZA", name: "Suedafrika" }, { code: "SG", name: "Singapur" },
];

function buildCountryPicker() {
  const list = (config && config.countries && config.countries.length) ? config.countries : DEFAULT_COUNTRIES;
  const preselect = new Set((config?.countries || DEFAULT_COUNTRIES.slice(0, 5)).map((c) => c.code));
  const merged = [...list];
  for (const d of DEFAULT_COUNTRIES) if (!merged.some((c) => c.code === d.code)) merged.push(d);
  countryPicker.innerHTML =
    `<span class="picker-label">Laender:</span>` +
    merged
      .map((c) => `<label class="chip"><input type="checkbox" value="${c.code}" data-name="${c.name || c.code}" ${preselect.has(c.code) ? "checked" : ""}/> ${c.name || c.code}</label>`)
      .join("");
}

function selectedCountries() {
  return [...countryPicker.querySelectorAll("input:checked")].map((i) => ({ code: i.value, name: i.dataset.name }));
}

async function runMeasurement(target, type, countries) {
  const isHttp = type === "http" || type === "https";
  const body = {
    target,
    type: isHttp ? "http" : "ping",
    locations: countries.map((c) => ({ country: c.code })),
    measurementOptions: isHttp
      ? { protocol: type === "https" ? "HTTPS" : "HTTP", request: { method: "HEAD" } }
      : { packets: (config && config.packets) || 3 },
  };
  const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`API-Fehler ${res.status}`);
  const { id } = await res.json();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const data = await (await fetch(`${API}/${id}`)).json();
    if (data.status !== "in-progress") return data;
    await sleep(1000);
  }
  throw new Error("Zeitueberschreitung");
}

function renderProbeResult(type, countries, data) {
  const isHttp = type === "http" || type === "https";
  const rows = countries
    .map((c, i) => {
      const entry = (data.results || [])[i] || {};
      const probe = entry.probe || {};
      const r = entry.result || {};
      const loc = [probe.city, probe.network].filter(Boolean).join(" · ") || c.code;
      if (isHttp) {
        const code = r.statusCode;
        const t = r.timings || {};
        const ok = typeof code === "number" && code < 400;
        const status = r.status === "failed" ? "down" : ok ? "up" : "down";
        return `<tr>
          <td><div class="country-cell"><span class="country-name">${c.name}</span><span class="country-sub">${loc}</span></div></td>
          <td>${statusBadge(status)}</td>
          <td><span class="mono">${code ?? "–"}</span></td>
          <td><span class="mono">${fmt(t.dns, "")}</span></td>
          <td><span class="mono">${fmt(t.tcp, "")}</span></td>
          <td><span class="mono">${fmt(t.tls, "")}</span></td>
          <td><span class="mono">${fmt(t.firstByte, "")}</span></td>
          <td><span class="mono">${fmt(t.total, " ms")}</span></td>
        </tr>`;
      }
      const s = r.stats || {};
      const status = r.status === "failed" ? "down" : typeof s.loss === "number" ? (s.loss >= 100 ? "down" : "up") : "unknown";
      return `<tr>
        <td><div class="country-cell"><span class="country-name">${c.name}</span><span class="country-sub">${loc}</span></div></td>
        <td>${statusBadge(status)}</td>
        <td><span class="mono">${fmt(s.avg, " ms")}</span></td>
        <td><span class="mono">${fmt(s.min, " ms")}</span></td>
        <td><span class="mono">${fmt(s.max, " ms")}</span></td>
        <td><span class="mono">${s.loss != null ? s.loss + " %" : "–"}</span></td>
      </tr>`;
    })
    .join("");
  const head = isHttp
    ? "<tr><th>Standort</th><th>Status</th><th>Code</th><th>DNS</th><th>TCP</th><th>TLS</th><th>TTFB</th><th>Gesamt</th></tr>"
    : "<tr><th>Standort</th><th>Status</th><th>Ø RTT</th><th>Min</th><th>Max</th><th>Verlust</th></tr>";
  probeResult.innerHTML = `<div class="table-wrap"><table class="status-table probe-table">
      <thead>${head}</thead><tbody>${rows}</tbody></table></div>
      ${isHttp ? '<p class="hint">Zeiten in ms · TTFB = Time to First Byte</p>' : ""}`;
}

probeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const target = probeTarget.value.trim();
  if (!target) { probeTarget.focus(); return; }
  const countries = selectedCountries();
  if (countries.length === 0) { probeResult.innerHTML = '<p class="hint" style="color:var(--danger)">Bitte mindestens ein Land auswaehlen.</p>'; return; }
  const type = probeType.value;
  probeBtn.disabled = true; probeBtn.textContent = "Messe …";
  probeResult.innerHTML = '<p class="hint">Messung laeuft …</p>';
  try {
    const data = await runMeasurement(target, type, countries);
    renderProbeResult(type, countries, data);
  } catch (err) {
    probeResult.innerHTML = `<p class="hint" style="color:var(--danger)">Fehler: ${err.message}</p>`;
  } finally {
    probeBtn.disabled = false; probeBtn.textContent = "Pruefen";
  }
});

// Bei Wechsel des Farbschemas neu zeichnen
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", loadStatic);

loadStatic();
