// Wiederverwendbare Visualisierungen fuer NetPulse (SVG, ohne externe Bibliothek).
// window.NetPulseChart.line(host, series, opts)  – Liniendiagramm (Zeitverlauf)
// window.NetPulseChart.uptime(host, rows, opts)  – Erreichbarkeits-Zeitleiste
(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
  const fmt = (n) => (typeof n === "number" ? n.toFixed(1) : "–");

  function el(tag, attrs = {}, text) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }

  function niceMax(v) {
    if (!(v > 0)) return 10;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return m * pow;
  }

  function fmtTime(ms, withDate) {
    const d = new Date(ms);
    const t = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    return withDate ? d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) + " " + t : t;
  }

  // series: [{ name, code, color, values: [{ t, v }] }]  (t = ms epoch, v = number|null)
  function line(host, series, opts = {}) {
    const unit = opts.unit || "ms";
    host.innerHTML = "";

    // Alle Zeitstempel einsammeln
    const tSet = new Set();
    const maps = series.map((s) => {
      const map = new Map();
      for (const p of s.values) if (typeof p.v === "number") { map.set(p.t, p.v); tSet.add(p.t); }
      return map;
    });
    const tAll = [...tSet].sort((a, b) => a - b);
    if (tAll.length === 0) {
      host.innerHTML = '<div class="empty-state">Noch keine Messpunkte.</div>';
      return;
    }

    const W = 760, H = 220;
    const m = { top: 12, right: 76, bottom: 26, left: 46 };
    const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
    const tMin = tAll[0], tMax = tAll[tAll.length - 1];
    const tSpan = tMax - tMin || 1;
    const withDate = tSpan > 24 * 3600 * 1000;

    let maxV = 0;
    for (const map of maps) for (const v of map.values()) maxV = Math.max(maxV, v);
    const yMax = niceMax(maxV);

    const xOf = (t) => m.left + ((t - tMin) / tSpan) * pw;
    const yOf = (v) => m.top + ph - (v / yMax) * ph;

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "line-chart", role: "img" });

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (yMax / ticks) * i;
      const y = yOf(v);
      svg.appendChild(el("line", { x1: m.left, y1: y, x2: m.left + pw, y2: y, class: "grid" }));
      svg.appendChild(el("text", { x: m.left - 8, y: y + 3, class: "axis-label", "text-anchor": "end" }, Math.round(v) + ""));
    }
    for (const t of [tMin, tMin + tSpan / 2, tMax]) {
      svg.appendChild(el("text", { x: xOf(t), y: H - 8, class: "axis-label", "text-anchor": "middle" }, fmtTime(t, withDate)));
    }
    svg.appendChild(el("text", { x: 4, y: m.top + 4, class: "axis-label", "text-anchor": "start" }, unit));

    const endLabels = [];
    series.forEach((s, si) => {
      const map = maps[si];
      let seg = [];
      const flush = () => {
        if (seg.length === 1) svg.appendChild(el("circle", { cx: xOf(seg[0]), cy: yOf(map.get(seg[0])), r: 2.5, fill: s.color }));
        else if (seg.length > 1)
          svg.appendChild(el("polyline", { points: seg.map((t) => `${xOf(t)},${yOf(map.get(t))}`).join(" "), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
        seg = [];
      };
      for (const t of tAll) (map.has(t) ? seg.push(t) : flush());
      flush();
      const lastT = [...tAll].reverse().find((t) => map.has(t));
      if (lastT != null) {
        svg.appendChild(el("circle", { cx: xOf(lastT), cy: yOf(map.get(lastT)), r: 3, fill: s.color }));
        endLabels.push({ code: s.code || s.name, color: s.color, y: yOf(map.get(lastT)) });
      }
    });

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

    const crosshair = el("line", { class: "crosshair", y1: m.top, y2: m.top + ph, x1: -10, x2: -10, visibility: "hidden" });
    svg.appendChild(crosshair);
    const dots = series.map((s) => {
      const c = el("circle", { r: 3.5, fill: s.color, stroke: isDark() ? "#1e293b" : "#fff", "stroke-width": 1.5, visibility: "hidden" });
      svg.appendChild(c);
      return c;
    });
    const capture = el("rect", { x: m.left, y: m.top, width: pw, height: ph, fill: "transparent" });
    svg.appendChild(capture);

    host.appendChild(svg);

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

    capture.addEventListener("mousemove", (evt) => {
      const rect = svg.getBoundingClientRect();
      const sx = W / rect.width;
      const px = (evt.clientX - rect.left) * sx;
      const idx = nearestIndex(tMin + ((px - m.left) / pw) * tSpan);
      const tv = tAll[idx];
      const cx = xOf(tv);
      crosshair.setAttribute("x1", cx); crosshair.setAttribute("x2", cx); crosshair.setAttribute("visibility", "visible");
      const rows = [];
      series.forEach((s, i) => {
        const v = maps[i].get(tv);
        if (typeof v === "number") {
          dots[i].setAttribute("cx", cx); dots[i].setAttribute("cy", yOf(v)); dots[i].setAttribute("visibility", "visible");
          rows.push(`<div class="tip-row"><span class="legend-swatch" style="background:${s.color}"></span><span>${s.name}</span><span class="tip-val">${fmt(v)} ${unit}</span></div>`);
        } else dots[i].setAttribute("visibility", "hidden");
      });
      tip.innerHTML = `<div class="tip-time">${fmtTime(tv, true)}</div>${rows.join("")}`;
      tip.style.display = "block";
      const left = Math.min((cx / W) * rect.width + 12, rect.width - tip.offsetWidth - 8);
      tip.style.left = Math.max(4, left) + "px";
      tip.style.top = "8px";
    });
    capture.addEventListener("mouseleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
      tip.style.display = "none";
    });
  }

  // rows: [{ name, cells: [{ t, status, title }] }]  status = 'up' | 'down' | 'unknown'
  function uptime(host, rows) {
    host.innerHTML = "";
    const table = document.createElement("div");
    table.className = "uptime";
    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "uptime-row";
      const label = document.createElement("span");
      label.className = "uptime-label";
      label.textContent = row.name;
      const strip = document.createElement("div");
      strip.className = "uptime-strip";
      for (const c of row.cells) {
        const cell = document.createElement("span");
        cell.className = "uptime-cell uptime-" + c.status;
        cell.title = c.title || "";
        strip.appendChild(cell);
      }
      line.appendChild(label);
      line.appendChild(strip);
      table.appendChild(line);
    }
    host.appendChild(table);
  }

  // Kompakte Sparkline fuer Antwortzeiten. points: [{ v, status }] (aeltester zuerst).
  function spark(host, points, opts = {}) {
    host.innerHTML = "";
    const color = opts.color || "#2a78d6";
    const W = 240, H = 36, pad = 3;
    if (points.length === 0) { host.innerHTML = '<span class="spark-empty">keine Daten</span>'; return; }
    // Nur erreichbare Punkte bilden die Linie, Ausfaelle brechen sie und werden rot markiert.
    const upVals = points.filter((p) => p.status !== "down" && typeof p.v === "number").map((p) => p.v);
    const min = upVals.length ? Math.min(...upVals) : 0;
    const max = upVals.length ? Math.max(...upVals) : 1;
    const span = max - min || 1;
    const n = points.length;
    const xOf = (i) => (n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad));
    const yOf = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "spark", preserveAspectRatio: "none" });
    let seg = [];
    const flush = () => {
      if (seg.length > 1) svg.appendChild(el("polyline", { points: seg.map(([x, y]) => `${x},${y}`).join(" "), fill: "none", stroke: color, "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      else if (seg.length === 1) svg.appendChild(el("circle", { cx: seg[0][0], cy: seg[0][1], r: 1.5, fill: color }));
      seg = [];
    };
    points.forEach((p, i) => (p.status !== "down" && typeof p.v === "number" ? seg.push([xOf(i), yOf(p.v)]) : flush()));
    flush();
    points.forEach((p, i) => {
      if (p.status === "down") svg.appendChild(el("circle", { cx: xOf(i), cy: H - pad, r: 2, fill: "#dc2626" }));
    });
    host.appendChild(svg);
  }

  window.NetPulseChart = { line, uptime, spark };
})();
