"use strict";
/* Ollamp – fetches /api/status once a second and draws the windows. No external requests. */
(() => {
  const $ = (id) => document.getElementById(id);
  const HISTORY = 120;
  const BUSY_PCT = 15;          // % GPU load that counts as "playing"
  const VIS_MODES = ["SPECTRUM · GPU LOAD", "OSCILLOSCOPE · WATTS", "VISUALIZATION OFF"];

  const st = {
    data: null, ok: false, paused: false, gpu: null, vis: 0,
    hist: {}, sampleTime: 0,
    busySince: null, lastBusy: 0, lastLength: 0,
    maxLeft: {}, bars: new Map(), peaks: new Map(), eqValues: [],
    marq: "OLLAMP", marqPos: 0, colors: null, instanceCount: 0,
  };

  // ---------- small helpers ----------
  const save = (k, v) => { try { localStorage.setItem("ollamp." + k, String(v)); } catch (e) { /* private mode */ } };
  const load = (k) => { try { return localStorage.getItem("ollamp." + k); } catch (e) { return null; } };
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const gb = (bytes) => (bytes == null ? "–" : (bytes / 1e9).toFixed(1) + "G");
  const timeText = (s) => {
    if (s == null) return "–";
    if (s > 1e7) return "∞";
    s = Math.round(s);
    const m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h ? `${h}:${String(m % 60).padStart(2, "0")}h` : `${m}:${String(s % 60).padStart(2, "0")}`;
  };
  const ktxt = (n) => (n == null ? "" : n >= 1024 ? Math.round(n / 1024) + "k" : String(n));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const allGpus = () => (st.data && st.data.gpus ? st.data.gpus : []);
  const selectedGpus = () => allGpus().filter((g) => st.gpu == null || g.index === st.gpu);
  const busy = (g) => (num(g.util) || 0) >= BUSY_PCT;

  function readColors() {
    const cs = getComputedStyle(document.body);
    const v = (n) => cs.getPropertyValue(n).trim();
    st.colors = { bg: v("--lcd-bg"), fg: v("--lcd-fg"), dim: v("--lcd-dim"), low: v("--vis-low"),
      mid: v("--vis-mid"), high: v("--vis-high"), peak: v("--peak") };
  }

  function prepare(cv) {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }

  // ---------- data ----------
  async function fetchStatus() {
    if (!st.paused && !document.hidden) {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        st.data = await r.json();
        st.ok = true;
        receive();
      } catch (e) {
        st.ok = false;
      }
      drawText();
    }
    setTimeout(fetchStatus, 1000);
  }

  function receive() {
    const now = performance.now();
    st.sampleTime = now;
    st.instanceCount = (st.data.instances || []).length;
    for (const g of allGpus()) {
      const h = st.hist[g.index] || (st.hist[g.index] = { util: [], watts: [] });
      h.util.push(num(g.util) || 0);
      h.watts.push(g.watts_max ? clamp((num(g.watts) || 0) / g.watts_max) : 0);
      if (h.util.length > HISTORY) { h.util.shift(); h.watts.shift(); }
    }
    if (selectedGpus().some(busy)) {
      if (st.busySince == null) st.busySince = now;
      st.lastBusy = now;
    } else if (st.busySince != null && now - st.lastBusy > 3000) {
      st.lastLength = st.lastBusy - st.busySince;
      st.busySince = null;
    }
  }

  // Does this GPU process belong to the instance? By systemd service name, or – with a
  // single instance – any process called "ollama…" (Docker, manual `ollama serve`, …).
  function belongs(p, name) {
    if (p.service === name) return true;
    return st.instanceCount === 1 && typeof p.comm === "string" && p.comm.startsWith("ollama");
  }
  function gpusForInstance(name) {
    return allGpus().filter((g) => (g.processes || []).some((p) => belongs(p, name))).map((g) => g.index);
  }

  // ---------- text, sliders, playlist ----------
  function drawText() {
    const d = st.data;
    const gpus = selectedGpus();
    const models = [];
    if (d) for (const inst of d.instances || []) for (const m of inst.models || []) models.push({ inst, m });

    // play state
    const state = $("state");
    const running = gpus.some(busy);
    state.textContent = st.paused ? "‖" : !st.ok ? "×" : running ? "▶" : models.length ? "‖" : "■";
    state.classList.toggle("blink", st.paused);

    // boxes
    const sum = (f) => gpus.reduce((a, g) => a + (num(g[f]) || 0), 0);
    $("watts").textContent = gpus.length ? String(Math.round(sum("watts"))).padStart(3, " ") : "---";
    const temps = gpus.map((g) => num(g.temp)).filter((v) => v != null);
    $("temp").textContent = temps.length ? String(Math.max(...temps)) : "--";
    const clocks = gpus.map((g) => num(g.clock)).filter((v) => v != null);
    $("mhz").textContent = clocks.length ? String(Math.max(...clocks)) : "----";
    const busyCount = allGpus().filter(busy).length;
    $("lamp1").classList.toggle("on", busyCount === 1);
    $("lamp2").classList.toggle("on", busyCount >= 2);
    $("lamp-on").classList.toggle("on", st.ok);
    $("lamp-auto").classList.toggle("on", st.ok && !st.paused);

    // VRAM as volume
    const used = sum("vram_mb"), total = sum("vram_total_mb");
    $("vol").style.setProperty("--v", (total ? used / total : 0).toFixed(3));
    $("vol-txt").textContent = total ? `${(used / 1024).toFixed(1)}/${(total / 1024).toFixed(0)}G` : "–";

    // balance between GPU 0 and 1
    const ag = allGpus();
    if (ag.length >= 2 && ag[0].vram_total_mb && ag[1].vram_total_mb) {
      const p0 = ag[0].vram_mb / ag[0].vram_total_mb, p1 = ag[1].vram_mb / ag[1].vram_total_mb;
      $("bal").style.setProperty("--v", clamp(0.5 + (p1 - p0) / 2).toFixed(3));
      $("bal-txt").textContent = `${Math.round(p0 * 100)}|${Math.round(p1 * 100)}%`;
    } else {
      $("bal").style.setProperty("--v", "0.5");
      $("bal-txt").textContent = "–";
    }

    // keep-alive as the seek bar: the model that unloads first
    let first = null;
    for (const x of models) {
      if (st.gpu != null && !gpusForInstance(x.inst.name).includes(st.gpu)) continue;
      if (x.m.left_s == null) continue;
      if (!first || x.m.left_s < first.m.left_s) first = x;
    }
    if (first) {
      const key = first.inst.name + "|" + first.m.name;
      st.maxLeft[key] = Math.max(st.maxLeft[key] || 0, first.m.left_s);
      const v = first.m.left_s > 1e7 ? 1 : first.m.left_s / (st.maxLeft[key] || 1);
      $("seek").style.setProperty("--v", clamp(v).toFixed(3));
      $("seek-txt").textContent = `KEEP-ALIVE: ${first.m.name} @ ${first.inst.name} · ${timeText(first.m.left_s)} left`;
    } else {
      $("seek").style.setProperty("--v", "0");
      $("seek-txt").textContent = "KEEP-ALIVE: nothing loaded";
    }

    $("gpu-select").textContent = st.gpu == null ? "ALL GPUS" : `GPU ${st.gpu}`;

    // marquee
    const parts = [];
    const active = new Set(allGpus().filter(busy).map((g) => g.index));
    for (const x of models) {
      const on = gpusForInstance(x.inst.name).some((i) => active.has(i));
      parts.push(`${on ? "▶ " : ""}${x.m.name} (${x.inst.name}${x.m.context ? ", ctx " + ktxt(x.m.context) : ""})`);
    }
    let text = !st.ok ? "OLLAMP *** SERVER NOT RESPONDING" : parts.length ? parts.join(" *** ") : "OLLAMP *** NO MODELS LOADED";
    if (d && d.gpu_error) text += " *** nvidia-smi: " + d.gpu_error;
    if (text + " *** " !== st.marq) { st.marq = text + " *** "; st.marqPos %= st.marq.length; }

    drawEq();
    drawPlaylist(models, active);
  }

  function drawEq() {
    const ag = allGpus();
    const band = (name, v, txt) => {
      const b = el("div", "band");
      const tr = el("div", "vtrack");
      tr.style.setProperty("--v", clamp(v).toFixed(3));
      tr.append(el("span", "vknob"));
      b.append(el("span", "bvalue", txt), tr, el("span", "bname", name));
      return b;
    };
    const groups = [];
    const sw = ag.reduce((a, g) => a + (num(g.watts) || 0), 0), sm = ag.reduce((a, g) => a + (num(g.watts_max) || 0), 0);
    const pre = el("div", "eq-group preamp");
    pre.append(el("div", "eq-heading", "ALL"), el("div", "eq-service", ""));
    const ps = el("div", "eq-sliders");
    ps.append(band("Σ W", sm ? sw / sm : 0, Math.round(sw) + "W"));
    pre.append(ps);
    groups.push(pre);
    st.eqValues = [];
    for (const g of ag) {
      const grp = el("div", "eq-group" + (st.gpu === g.index ? " selected" : ""));
      const short = (g.name || "GPU").replace(/^NVIDIA\s+/i, "").replace(/GeForce\s+/i, "");
      const services = [...new Set((g.processes || []).map((p) => p.service || p.comm).filter(Boolean))];
      grp.append(el("div", "eq-heading", `GPU ${g.index} · ${short}`), el("div", "eq-service", services.join(" · ") || "idle"));
      const row = el("div", "eq-sliders");
      const values = [
        ["LOAD", (num(g.util) || 0) / 100, `${num(g.util) ?? "–"}%`],
        ["BUS", (num(g.mem_bus) || 0) / 100, `${num(g.mem_bus) ?? "–"}%`],
        ["VRAM", g.vram_total_mb ? g.vram_mb / g.vram_total_mb : 0, g.vram_mb != null ? (g.vram_mb / 1024).toFixed(1) + "G" : "–"],
        ["WATT", g.watts_max ? (num(g.watts) || 0) / g.watts_max : 0, g.watts != null ? Math.round(g.watts) + "W" : "–"],
        ["TEMP", ((num(g.temp) || 25) - 25) / 65, g.temp != null ? g.temp + "°" : "–"],
      ];
      for (const [n, v, t] of values) { row.append(band(n, v, t)); st.eqValues.push(clamp(v)); }
      grp.append(row);
      groups.push(grp);
    }
    if (!ag.length) {
      const grp = el("div", "eq-group");
      grp.append(el("div", "eq-heading", st.data && st.data.gpu_error ? "nvidia-smi failed" : "no GPUs"));
      groups.push(grp);
    }
    $("eq-bands").replaceChildren(...groups);
  }

  function drawPlaylist(models, active) {
    const rows = [];
    let n = 0;
    const d = st.data;
    if (!d) { rows.push(el("li", "empty", st.ok ? "Waiting for data…" : "Server not responding.")); }
    else {
      for (const inst of d.instances || []) {
        const gpus = gpusForInstance(inst.name);
        const head = el("li", "instance" + (inst.up ? "" : " down"));
        head.append(
          el("span", "name", `${inst.name.toUpperCase()} :${inst.port}`),
          el("span", "right", inst.up ? `v${inst.version || "?"}${gpus.length ? " · GPU " + gpus.join("+") : ""}` : `NOT RESPONDING (${inst.error || "?"})`),
        );
        rows.push(head);
        if (inst.up && !(inst.models || []).length) rows.push(el("li", "empty", "     (nothing loaded)"));
        for (const m of inst.models || []) {
          n += 1;
          const on = gpus.some((i) => active.has(i));
          const li = el("li", on ? "active" : "");
          const share = m.size ? Math.round((100 * (m.vram || 0)) / m.size) : null;
          const bits = [];
          if (m.context) bits.push("ctx " + ktxt(m.context));
          if (share != null) bits.push(`${share}% GPU`);
          bits.push(gb(m.size));
          bits.push(timeText(m.left_s));
          li.append(el("span", "nr", `${n}.`), el("span", "name", m.name), el("span", "right", bits.join("  ")));
          li.title = [m.family, m.params, m.quant, m.vram != null ? `${gb(m.vram)} in VRAM` : null].filter(Boolean).join(" · ");
          rows.push(li);
        }
      }
    }
    $("playlist").replaceChildren(...rows);
    const ag = allGpus();
    const used = ag.reduce((a, g) => a + (num(g.vram_mb) || 0), 0) / 1024;
    const total = ag.reduce((a, g) => a + (num(g.vram_total_mb) || 0), 0) / 1024;
    const up = d ? (d.instances || []).filter((i) => i.up).length : 0;
    $("summary").textContent = d ? `${up}/${(d.instances || []).length} INST · ${n} MOD · ${used.toFixed(1)}/${total.toFixed(0)}G` : "–";
  }

  // ---------- canvas ----------
  const SEG = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg", "-": "g", " ": "" };
  function digit(ctx, x, y, w, h, ch, on, off) {
    const t = Math.max(2, w * 0.2), m = h / 2;
    const s = {
      a: [x + t, y, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t], g: [x + t, y + m - t / 2, w - 2 * t, t],
      f: [x, y + t, t, m - 1.5 * t], b: [x + w - t, y + t, t, m - 1.5 * t],
      e: [x, y + m + t / 2, t, m - 1.5 * t], c: [x + w - t, y + m + t / 2, t, m - 1.5 * t],
    };
    const lit = SEG[ch] || "";
    for (const k in s) { ctx.fillStyle = lit.includes(k) ? on : off; ctx.fillRect(...s[k]); }
  }

  function drawTimer(now) {
    const { ctx, w, h } = prepare($("timer"));
    const c = st.colors;
    ctx.clearRect(0, 0, w, h);
    const ms = st.busySince != null ? now - st.busySince : st.lastLength;
    const blink = (st.busySince == null && st.lastLength > 0) || st.paused;
    const visible = !blink || Math.floor(now / 500) % 2 === 0;
    const s = Math.floor(ms / 1000);
    const chars = !st.ok && !st.data ? "--:--" : `${String(Math.min(99, Math.floor(s / 60))).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    const sh = Math.min(h - 4, 30), sw = sh * 0.52, gap = sw * 0.32;
    let x = Math.max(2, w - (sw * 4 + gap * 5 + sw * 0.4) - 2);
    const y = (h - sh) / 2;
    for (const ch of chars) {
      if (ch === ":") {
        ctx.fillStyle = visible ? c.fg : c.dim;
        const p = Math.max(2, sw * 0.2);
        ctx.fillRect(x, y + sh * 0.28, p, p);
        ctx.fillRect(x, y + sh * 0.66, p, p);
        x += p + gap;
      } else {
        digit(ctx, x, y, sw, sh, ch, visible ? c.fg : c.dim, c.dim);
        x += sw + gap;
      }
    }
  }

  function background(ctx, w, h) {
    const c = st.colors;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = c.dim;
    for (let y = 1; y < h; y += 4) for (let x = 1; x < w; x += 4) ctx.fillRect(x, y, 1, 1);
  }

  function drawVis(now) {
    const { ctx, w, h } = prepare($("vis"));
    const c = st.colors;
    background(ctx, w, h);
    const gpus = selectedGpus();
    if (st.vis === 2 || !gpus.length) return;

    if (st.vis === 0) {
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, c.low); grad.addColorStop(0.55, c.mid); grad.addColorStop(1, c.high);
      const step = 4, total = Math.floor((w + 1) / step);
      const perGroup = Math.max(1, Math.floor((total - (gpus.length - 1)) / gpus.length));
      let x = 0;
      gpus.forEach((g, gi) => {
        const hist = (st.hist[g.index] || { util: [] }).util.slice(-perGroup);
        while (hist.length < perGroup) hist.unshift(0);
        for (let i = 0; i < perGroup; i++) {
          const key = gi * 1000 + i;
          const target = (hist[i] / 100) * (h - 2);
          const cur = st.bars.get(key) || 0;
          const next = cur + (target - cur) * 0.22;
          st.bars.set(key, next);
          const peak = Math.max((st.peaks.get(key) || 0) - 0.35, next);
          st.peaks.set(key, peak);
          ctx.fillStyle = grad;
          ctx.fillRect(x, h - next, step - 1, next);
          if (peak > 1) { ctx.fillStyle = c.peak; ctx.fillRect(x, h - peak - 1, step - 1, 1); }
          x += step;
        }
        x += step;
      });
    } else {
      const frac = clamp((now - st.sampleTime) / 1000);
      const n = 60, dx = w / (n - 1);
      const palette = [c.low, c.high, c.mid, c.peak];
      gpus.forEach((g) => {
        const hist = (st.hist[g.index] || { watts: [] }).watts.slice(-(n + 1));
        if (hist.length < 2) return;
        ctx.strokeStyle = palette[g.index % palette.length];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        hist.forEach((v, i) => {
          const xx = w - (hist.length - 1 - i + frac) * dx;
          const yy = h - 2 - v * (h - 4);
          i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
        });
        ctx.stroke();
      });
    }
    // scanlines for the LCD feel
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = c.bg;
    for (let y = 1; y < h; y += 2) ctx.fillRect(0, y, w, 1);
    ctx.globalAlpha = 1;
  }

  function drawEqCurve() {
    const { ctx, w, h } = prepare($("eq-curve"));
    const c = st.colors;
    background(ctx, w, h);
    ctx.fillStyle = c.dim;
    ctx.fillRect(0, Math.round(h / 2), w, 1);
    const v = st.eqValues;
    if (v.length < 2) return;
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, c.low); grad.addColorStop(0.55, c.mid); grad.addColorStop(1, c.high);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const dx = (w - 8) / (v.length - 1);
    const p = v.map((x, i) => [4 + i * dx, h - 3 - x * (h - 6)]);
    ctx.moveTo(...p[0]);
    for (let i = 1; i < p.length; i++) {
      const mx = (p[i - 1][0] + p[i][0]) / 2;
      ctx.bezierCurveTo(mx, p[i - 1][1], mx, p[i][1], p[i][0], p[i][1]);
    }
    ctx.stroke();
  }

  function loop(now) {
    if (st.colors) {
      drawTimer(now);
      drawVis(now);
      drawEqCurve();
    }
    requestAnimationFrame(loop);
  }

  // marquee, one character at a time like the original
  setInterval(() => {
    const t = st.marq;
    st.marqPos = (st.marqPos + 1) % t.length;
    $("marquee").textContent = (t.slice(st.marqPos) + t + t).slice(0, 200);
  }, 230);

  // ---------- buttons ----------
  function switchGpu(dir) {
    const opts = [null, ...allGpus().map((g) => g.index)];
    const i = opts.indexOf(st.gpu);
    st.gpu = opts[(i + dir + opts.length) % opts.length];
    st.bars.clear(); st.peaks.clear();
    save("gpu", st.gpu == null ? "" : st.gpu);
    drawText();
  }
  function switchVis() {
    st.vis = (st.vis + 1) % VIS_MODES.length;
    $("vis-mode").textContent = VIS_MODES[st.vis];
    save("vis", st.vis);
  }
  function pause(p) { st.paused = p; $("b-pause").classList.toggle("down", p); drawText(); }
  function stop() {
    st.hist = {}; st.bars.clear(); st.peaks.clear(); st.maxLeft = {};
    st.busySince = null; st.lastLength = 0;
    drawText();
  }

  $("b-prev").addEventListener("click", () => switchGpu(-1));
  $("b-next").addEventListener("click", () => switchGpu(1));
  $("b-gpu").addEventListener("click", () => switchGpu(1));
  $("b-play").addEventListener("click", () => pause(false));
  $("b-pause").addEventListener("click", () => pause(!st.paused));
  $("b-stop").addEventListener("click", stop);
  $("b-vis").addEventListener("click", switchVis);
  $("vis").addEventListener("click", switchVis);
  // Winamp's keys: z x c v b
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "z") switchGpu(-1);
    else if (k === "x") pause(false);
    else if (k === "c") pause(!st.paused);
    else if (k === "v") stop();
    else if (k === "b") switchGpu(1);
  });

  // ---------- start ----------
  const savedVis = Number(load("vis"));
  if (savedVis >= 0 && savedVis < VIS_MODES.length) st.vis = savedVis;
  $("vis-mode").textContent = VIS_MODES[st.vis];
  const savedGpu = load("gpu");
  if (savedGpu) st.gpu = Number(savedGpu);
  readColors();
  fetchStatus();
  requestAnimationFrame(loop);
})();
