// NetPulse Check Worker
// Fuehrt Healthchecks fuer HTTP, HTTPS und Ping (TCP-Connect) aus und liefert
// Status, Statuscode und Antwortzeit. Wird vom GitHub-Pages-Dashboard alle 10s
// abgefragt. Cloudflare Workers koennen kein ICMP, daher ist Ping ein TCP-Connect
// auf Port 443 mit Fallback auf 80.

import { connect } from "cloudflare:sockets";

const TIMEOUT_MS = 8000;
const PING_PORTS = [443, 80];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, origin, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// Entfernt ein vorhandenes Schema, damit http:// und https:// sauber gebildet werden.
function stripScheme(target) {
  return target.replace(/^https?:\/\//i, "");
}

function hostOf(target) {
  try {
    return new URL(/^https?:\/\//i.test(target) ? target : "http://" + target).hostname;
  } catch (_) {
    return stripScheme(target).split(/[/:?#]/)[0];
  }
}

async function checkHttp(target, secure) {
  const url = (secure ? "https://" : "http://") + stripScheme(target);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: ctrl.signal });
    const ms = Date.now() - start;
    const code = res.status;
    return { status: code >= 200 && code < 400 ? "up" : "down", code, ms };
  } catch (err) {
    return { status: "down", ms: Date.now() - start, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkPing(target) {
  const hostname = hostOf(target);
  for (const port of PING_PORTS) {
    const start = Date.now();
    let socket;
    try {
      socket = connect({ hostname, port });
      await Promise.race([
        socket.opened,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
      ]);
      const ms = Date.now() - start;
      try { await socket.close(); } catch (_) {}
      return { status: "up", ms, port };
    } catch (err) {
      try { await socket?.close(); } catch (_) {}
      if (port === PING_PORTS[PING_PORTS.length - 1])
        return { status: "down", ms: Date.now() - start, error: String(err && err.message || err) };
    }
  }
  return { status: "down" };
}

async function runCheck(target, type) {
  if (type === "http") return { target, type, ...(await checkHttp(target, false)) };
  if (type === "https") return { target, type, ...(await checkHttp(target, true)) };
  if (type === "ping") return { target, type, ...(await checkPing(target)) };
  return { target, type, status: "down", error: "unknown type" };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });

    let targets = [];
    let types = ["http", "https", "ping"];
    try {
      if (request.method === "POST") {
        const body = await request.json();
        if (Array.isArray(body.targets)) targets = body.targets;
        if (Array.isArray(body.types) && body.types.length) types = body.types;
      } else {
        const url = new URL(request.url);
        const t = url.searchParams.get("targets");
        if (t) targets = t.split(",").map((s) => s.trim()).filter(Boolean);
        const ty = url.searchParams.get("types");
        if (ty) types = ty.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } catch (_) {
      return json({ error: "invalid request body" }, origin, 400);
    }

    targets = [...new Set(targets.map((s) => String(s).trim()).filter(Boolean))].slice(0, 50);
    if (targets.length === 0) return json({ error: "no targets" }, origin, 400);

    const tasks = [];
    for (const target of targets) for (const type of types) tasks.push(runCheck(target, type));
    const results = await Promise.all(tasks);

    return json({ checkedAt: new Date().toISOString(), results }, origin);
  },
};
