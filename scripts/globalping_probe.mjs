#!/usr/bin/env node
// Fuehrt fuer jedes Ziel aus docs/config.json eine Globalping-Messung aus
// (ein Probe pro konfiguriertem Land) und schreibt das Ergebnis nach
// docs/data/status.json. Benoetigt Node 18+ (globales fetch), keine Pakete.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "docs/config.json");
const OUTPUT_PATH = resolve(ROOT, "docs/data/status.json");
const HISTORY_PATH = resolve(ROOT, "docs/data/history.json");
const HISTORY_MAX_POINTS = 480; // ~5 Tage bei 15-Min-Takt
const API = "https://api.globalping.io/v1/measurements";

// Optionales Token (hoeheres Rate-Limit). Nur im CI-Job, nie im Frontend.
const TOKEN = process.env.GLOBALPING_TOKEN;

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function createMeasurement(target, type, countries, packets) {
  const body = {
    target,
    type,
    locations: countries.map((c) => ({ country: c.code })),
    measurementOptions: { packets },
  };
  const res = await fetch(API, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${target} -> ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.id;
}

async function waitForResult(id) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/${id}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`GET ${id} -> ${res.status}`);
    const data = await res.json();
    if (data.status !== "in-progress") return data;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timeout waiting for measurement ${id}`);
}

function deriveStatus(result) {
  if (!result || result.status === "failed") return "down";
  const stats = result.stats || {};
  if (typeof stats.loss !== "number") return "unknown";
  if (stats.loss >= 100) return "down";
  return "up";
}

// Ordnet die von der API gelieferten Ergebnisse den konfigurierten Laendern zu.
// Die API liefert Ergebnisse in der Reihenfolge der gesendeten locations.
function mapResults(countries, apiResults) {
  return countries.map((country, idx) => {
    const entry = apiResults[idx];
    const probe = entry?.probe || {};
    const result = entry?.result || {};
    const stats = result.stats || {};
    return {
      country: country.code,
      name: country.name || country.code,
      city: probe.city || null,
      network: probe.network || null,
      status: deriveStatus(result),
      loss: typeof stats.loss === "number" ? stats.loss : null,
      min: typeof stats.min === "number" ? stats.min : null,
      avg: typeof stats.avg === "number" ? stats.avg : null,
      max: typeof stats.max === "number" ? stats.max : null,
    };
  });
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const { targets, countries, type = "ping", packets = 3 } = config;

  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("config.json: 'targets' ist leer");
  }
  if (!Array.isArray(countries) || countries.length === 0) {
    throw new Error("config.json: 'countries' ist leer");
  }

  const out = { generatedAt: new Date().toISOString(), type, targets: [] };

  for (const target of targets) {
    try {
      const id = await createMeasurement(target, type, countries, packets);
      const data = await waitForResult(id);
      out.targets.push({
        target,
        results: mapResults(countries, data.results || []),
      });
      console.log(`OK  ${target} (${id})`);
    } catch (err) {
      console.error(`ERR ${target}: ${err.message}`);
      // Ziel trotzdem aufnehmen, damit das Frontend den Fehler anzeigen kann.
      out.targets.push({
        target,
        error: err.message,
        results: countries.map((c) => ({
          country: c.code,
          name: c.name || c.code,
          status: "unknown",
          loss: null,
          min: null,
          avg: null,
          max: null,
        })),
      });
    }
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\nGeschrieben: ${OUTPUT_PATH}`);

  await appendHistory(out);
  console.log(`Geschrieben: ${HISTORY_PATH}`);
}

// Haengt einen Verlaufspunkt an history.json an (Ø RTT pro Ziel pro Land) und
// begrenzt die Anzahl der gespeicherten Punkte.
async function appendHistory(out) {
  let history = { maxPoints: HISTORY_MAX_POINTS, points: [] };
  try {
    const existing = JSON.parse(await readFile(HISTORY_PATH, "utf8"));
    if (Array.isArray(existing.points)) history = existing;
  } catch (_) {
    /* erste Ausfuehrung: neue Historie */
  }
  history.maxPoints = HISTORY_MAX_POINTS;

  const data = {};
  for (const t of out.targets) {
    data[t.target] = {};
    for (const r of t.results || []) {
      data[t.target][r.country] = typeof r.avg === "number" ? r.avg : null;
    }
  }
  history.points.push({ t: out.generatedAt, data });
  if (history.points.length > history.maxPoints) {
    history.points = history.points.slice(-history.maxPoints);
  }

  await writeFile(HISTORY_PATH, JSON.stringify(history) + "\n", "utf8");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
