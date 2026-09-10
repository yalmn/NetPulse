// NetPulse Status-Seite – rendert docs/data/status.json und erlaubt optional
// eine Live-Messung direkt gegen die Globalping-API (CORS ist aktiv).

const API = "https://api.globalping.io/v1/measurements";
const content = document.getElementById("content");
const lastUpdated = document.getElementById("last-updated");
const liveBtn = document.getElementById("live-check");

let config = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (typeof n === "number" ? n.toFixed(1) : "–");

function statusBadge(status) {
  const label = status === "up" ? "Erreichbar" : status === "down" ? "Ausfall" : "Unbekannt";
  return `<span class="status-badge status-${status}"><span class="status-dot"></span>${label}</span>`;
}

function rttCell(avg) {
  if (typeof avg !== "number") return '<span class="mono">–</span>';
  const warn = config && avg > (config.latencyWarnMs || Infinity);
  return `<span class="mono ${warn ? "rtt-warn" : ""}">${fmt(avg)} ms</span>`;
}

function renderTargets(targets) {
  if (!targets || targets.length === 0) {
    content.innerHTML = '<div class="card"><div class="empty-state">Noch keine Messdaten vorhanden.</div></div>';
    return;
  }
  content.innerHTML = targets
    .map((t) => {
      const rows = (t.results || [])
        .map(
          (r) => `
          <tr>
            <td>
              <div class="country-cell">
                <span class="country-name">${r.name || r.country}</span>
                <span class="country-sub">${[r.city, r.network].filter(Boolean).join(" · ") || r.country}</span>
              </div>
            </td>
            <td>${statusBadge(r.status)}</td>
            <td>${rttCell(r.avg)}</td>
            <td><span class="mono">${fmt(r.min)}${r.min != null ? " ms" : ""}</span></td>
            <td><span class="mono">${fmt(r.max)}${r.max != null ? " ms" : ""}</span></td>
            <td><span class="mono">${r.loss != null ? r.loss + " %" : "–"}</span></td>
          </tr>`
        )
        .join("");
      const err = t.error ? `<div class="empty-state" style="color:var(--danger)">Fehler: ${t.error}</div>` : "";
      return `
        <div class="card">
          <div class="card-header-bar"><h3>${t.target}</h3></div>
          ${err}
          <div class="table-wrap">
            <table class="status-table">
              <thead>
                <tr><th>Standort</th><th>Status</th><th>Ø RTT</th><th>Min</th><th>Max</th><th>Verlust</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    })
    .join("");
}

function setUpdated(iso, live) {
  if (!iso) {
    lastUpdated.textContent = "Keine Daten";
    return;
  }
  const d = new Date(iso);
  lastUpdated.textContent = (live ? "Live · " : "Stand: ") + d.toLocaleString("de-DE");
}

// ── Statische Daten laden ──
async function loadStatic() {
  try {
    config = await (await fetch("config.json", { cache: "no-store" })).json();
    document.getElementById("page-title").textContent = config.title || "Globale Erreichbarkeit";
  } catch (_) {
    /* config optional fuers Rendern der statischen Daten */
  }
  try {
    const data = await (await fetch("data/status.json", { cache: "no-store" })).json();
    renderTargets(data.targets);
    setUpdated(data.generatedAt, false);
  } catch (_) {
    content.innerHTML = '<div class="card"><div class="empty-state">status.json konnte nicht geladen werden.</div></div>';
    setUpdated(null, false);
  }
}

// ── Live-Messung im Browser ──
function deriveStatus(result) {
  if (!result || result.status === "failed") return "down";
  const loss = result.stats && result.stats.loss;
  if (typeof loss !== "number") return "unknown";
  return loss >= 100 ? "down" : "up";
}

async function liveMeasure(target, countries, type, packets) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target,
      type,
      locations: countries.map((c) => ({ country: c.code })),
      measurementOptions: { packets },
    }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const { id } = await res.json();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const data = await (await fetch(`${API}/${id}`)).json();
    if (data.status !== "in-progress") {
      return countries.map((c, i) => {
        const entry = (data.results || [])[i] || {};
        const probe = entry.probe || {};
        const r = entry.result || {};
        const s = r.stats || {};
        return {
          country: c.code, name: c.name || c.code, city: probe.city, network: probe.network,
          status: deriveStatus(r),
          loss: typeof s.loss === "number" ? s.loss : null,
          min: s.min ?? null, avg: s.avg ?? null, max: s.max ?? null,
        };
      });
    }
    await sleep(1000);
  }
  throw new Error("Timeout");
}

async function runLive() {
  if (!config || !config.targets) {
    await loadStatic();
    if (!config || !config.targets) return;
  }
  liveBtn.disabled = true;
  liveBtn.textContent = "Messe …";
  const { targets, countries, type = "ping", packets = 3 } = config;
  const out = [];
  for (const target of targets) {
    try {
      out.push({ target, results: await liveMeasure(target, countries, type, packets) });
    } catch (err) {
      out.push({ target, error: err.message, results: [] });
    }
    renderTargets(out);
  }
  setUpdated(new Date().toISOString(), true);
  liveBtn.disabled = false;
  liveBtn.textContent = "Jetzt pruefen";
}

liveBtn.addEventListener("click", runLive);
loadStatic();
