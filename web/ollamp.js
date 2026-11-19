"use strict";
/* Ollamp – fetches /api/status once a second and drives the modules. No external requests. */
(() => {
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const HISTORY = 120;
  const BUSY_PCT = 15;                 // % GPU load that counts as "running"
  const SEGMENTS = 10;                 // LEDs per ladder
  const MODES = ["GPU LOAD", "POWER DRAW", "OFF"];
  const GPU_COLORS = ["--cyan", "--pink", "--yellow", "--green", "--orange"];
  const CABLE_COLORS = ["--pink", "--cyan", "--yellow", "--green", "--orange"];

  const st = {
    data: null, ok: false, paused: false, gpu: null, mode: 0,
    hist: {}, sampleTime: 0,
    busySince: null, lastBusy: 0, lastLength: 0,
    maxLeft: {}, bars: new Map(), peaks: new Map(),
    gpuKey: "", instKey: "", gpuMods: new Map(), instMods: new Map(),
    colors: null,
  };

  // ---------- helpers ----------
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
  const setKnob = (k, v) => k.style.setProperty("--v", clamp(v || 0).toFixed(3));
  const css = (name) => st.colors[name] || "#fff";

  const allGpus = () => (st.data && st.data.gpus ? st.data.gpus : []);
  const instances = () => (st.data && st.data.instances ? st.data.instances : []);
  const selectedGpus = () => allGpus().filter((g) => st.gpu == null || g.index === st.gpu);
  const busy = (g) => (num(g.util) || 0) >= BUSY_PCT;
  const gpuColor = (i) => css(GPU_COLORS[i % GPU_COLORS.length]);

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    st.colors = {};
    for (const n of ["--seg-on", "--seg-off", "--phosphor", "--phosphor-dim", "--screen-bg",
      "--cyan", "--pink", "--yellow", "--green", "--orange", "--red"]) st.colors[n] = cs.getPropertyValue(n).trim();
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

  // A process belongs to an instance by systemd service name, or – with a single
  // instance – by being called "ollama…" (Docker, manual `ollama serve`, Windows).
  function belongs(p, name) {
    if (p.service === name) return true;
    return instances().length === 1 && typeof p.comm === "string" && p.comm.startsWith("ollama");
  }
  const gpusForInstance = (name) =>
    allGpus().filter((g) => (g.processes || []).some((p) => belongs(p, name))).map((g) => g.index);

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
      render();
    }
    setTimeout(fetchStatus, 1000);
  }

  function receive() {
    const now = performance.now();
    st.sampleTime = now;
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

  // ---------- building modules ----------
  function knobBox(label, small) {
    const box = el("div", "knob-box");
    const k = el("div", "knob" + (small ? " small" : ""));
    const v = el("span", "kvalue", "–");
    box.append(k, el("span", "klabel", label), v);
    return { box, knob: k, value: v };
  }

  function screws(m) { m.append(el("span", "screw tl"), el("span", "screw br")); }

  function buildGpuModules() {
    const gpus = allGpus();
    const key = gpus.map((g) => g.uuid).join("|");
    if (key === st.gpuKey) return;
    st.gpuKey = key;
    for (const m of st.gpuMods.values()) m.el.remove();
    st.gpuMods.clear();
    const row = $("row-top");
    for (const g of gpus) {
      const m = el("section", "mod mod-gpu");
      m.setAttribute("aria-label", `GPU ${g.index}`);
      screws(m);
      const head = el("header", "mod-head");
      const short = (g.name || "GPU").replace(/^NVIDIA\s+/i, "").replace(/GeForce\s+/i, "");
      head.append(el("h2", null, `GPU ${g.index}`), el("small", null, short));
      const act = el("span", "led green"), sel = el("span", "led cyan");
      const status = el("div", "gpu-status");
      const b1 = el("span", "led-box"); b1.append(act, "ACT");
      const b2 = el("span", "led-box"); b2.append(sel, "SEL");
      status.append(b1, b2);
      const ladders = el("div", "ladders");
      const lad = {};
      for (const name of ["LOAD", "BUS", "VRAM", "WATT", "TEMP"]) {
        const box = el("div", "ladder-box");
        const l = el("div", "ladder");
        for (let i = 0; i < SEGMENTS; i++) l.append(el("i"));
        const val = el("span", "lvalue", "–");
        box.append(l, el("span", "lname", name), val);
        ladders.append(box);
        lad[name] = { segs: [...l.children], value: val };
      }
      const knobs = el("div", "knobs");
      const clock = knobBox("CLOCK", true), fan = knobBox("FAN", true);
      knobs.append(clock.box, fan.box);
      const jb = el("div", "jack-box");
      const jack = el("span", "jack"), note = el("span", "jack-note", "");
      jb.append(note, el("span", "jack-label", "IN"), jack);
      m.append(head, status, ladders, knobs, jb);
      row.append(m);
      st.gpuMods.set(g.index, { el: m, act, sel, lad, clock, fan, jack, note });
    }
  }

  function buildInstModules() {
    const inst = instances();
    const key = inst.map((i) => i.name + ":" + i.port).join("|");
    if (key === st.instKey) return;
    st.instKey = key;
    const row = $("row-inst");
    row.replaceChildren();
    st.instMods.clear();
    inst.forEach((i, n) => {
      const m = el("section", "mod mod-inst");
      m.setAttribute("aria-label", `Ollama instance ${i.name}`);
      screws(m);
      const head = el("header", "mod-head");
      head.append(el("h2", null, i.name.toUpperCase()), el("small", null, `PORT ${i.port}`));
      const led = el("span", "led");
      const ver = el("span", null, "–");
      const meta = el("div", "inst-meta");
      meta.append(led, ver);
      const models = el("div", "models");
      const jb = el("div", "jack-box");
      const jack = el("span", "jack"), note = el("span", "jack-note", "");
      jb.append(note, el("span", "jack-label", "OUT"), jack);
      m.append(head, meta, models, jb);
      row.append(m);
      st.instMods.set(i.name, { el: m, led, ver, models, jack, note, color: CABLE_COLORS[n % CABLE_COLORS.length] });
    });
  }

  // ---------- updating ----------
  function setLadder(l, v, txt) {
    const lit = Math.round(clamp(v) * SEGMENTS);
    l.segs.forEach((s, i) => s.classList.toggle("on", i < lit));
    l.value.textContent = txt;
  }

  function render() {
    buildGpuModules();
    buildInstModules();
    const ag = allGpus();
    const sel = selectedGpus();
    const active = new Set(ag.filter(busy).map((g) => g.index));
    const inst = instances();
    const anyDown = inst.some((i) => !i.up);
    const models = inst.reduce((a, i) => a + (i.models || []).length, 0);

    // CLK
    const running = sel.some(busy);
    $("led-run").classList.toggle("on", st.ok && running && !st.paused);
    $("led-idle").classList.toggle("on", st.ok && !running && !st.paused);
    $("led-hold").classList.toggle("on", st.paused);
    $("led-hold").classList.toggle("blink", st.paused);
    $("led-btn-hold").classList.toggle("on", st.paused);
    $("led-err").classList.toggle("on", !st.ok || anyDown || !!(st.data && st.data.gpu_error));
    $("b-hold").classList.toggle("down", st.paused);
    const sw = ag.reduce((a, g) => a + (num(g.watts) || 0), 0), sm = ag.reduce((a, g) => a + (num(g.watts_max) || 0), 0);
    setKnob($("k-power"), sm ? sw / sm : 0);
    $("v-power").textContent = ag.length ? `${Math.round(sw)} W` : "–";
    const vu = ag.reduce((a, g) => a + (num(g.vram_mb) || 0), 0), vt = ag.reduce((a, g) => a + (num(g.vram_total_mb) || 0), 0);
    setKnob($("k-vram"), vt ? vu / vt : 0);
    $("v-vram").textContent = vt ? `${(vu / 1024).toFixed(1)}/${(vt / 1024).toFixed(0)}G` : "–";
    $("gpu-sel").textContent = st.gpu == null ? "ALL" : `GPU ${st.gpu}`;

    // SCOPE
    $("scope-mode").textContent = MODES[st.mode];
    const legend = sel.map((g) => { const s = el("span"); const i = el("i"); i.style.setProperty("--c", gpuColor(g.index)); s.append(i, `GPU ${g.index}`); return s; });
    $("scope-legend").replaceChildren(...legend);
    const util = sel.length ? Math.round(sel.reduce((a, g) => a + (num(g.util) || 0), 0) / sel.length) : null;
    const temps = sel.map((g) => num(g.temp)).filter((v) => v != null);
    $("summary").textContent = !st.ok ? "NO SIGNAL"
      : st.data && st.data.gpu_error ? st.data.gpu_error.toUpperCase()
      : `${util ?? "–"}% LOAD · ${Math.round(sel.reduce((a, g) => a + (num(g.watts) || 0), 0))} W · ${temps.length ? Math.max(...temps) : "–"} °C`;

    // GPU modules
    for (const g of ag) {
      const m = st.gpuMods.get(g.index);
      if (!m) continue;
      m.el.classList.toggle("selected", st.gpu === g.index);
      m.act.classList.toggle("on", busy(g));
      m.act.classList.toggle("blink", busy(g));
      m.sel.classList.toggle("on", st.gpu === g.index);
      setLadder(m.lad.LOAD, (num(g.util) || 0) / 100, `${num(g.util) ?? "–"}%`);
      setLadder(m.lad.BUS, (num(g.mem_bus) || 0) / 100, `${num(g.mem_bus) ?? "–"}%`);
      setLadder(m.lad.VRAM, g.vram_total_mb ? g.vram_mb / g.vram_total_mb : 0, g.vram_mb != null ? (g.vram_mb / 1024).toFixed(1) + "G" : "–");
      setLadder(m.lad.WATT, g.watts_max ? (num(g.watts) || 0) / g.watts_max : 0, g.watts != null ? Math.round(g.watts) + "W" : "–");
      setLadder(m.lad.TEMP, ((num(g.temp) || 25) - 25) / 65, g.temp != null ? g.temp + "°" : "–");
      setKnob(m.clock.knob, g.clock_max ? (num(g.clock) || 0) / g.clock_max : 0);
      m.clock.value.textContent = g.clock != null ? `${g.clock} MHz` : "–";
      setKnob(m.fan.knob, (num(g.fan) || 0) / 100);
      m.fan.value.textContent = g.fan != null ? `${g.fan}%` : "–";
      const services = [...new Set((g.processes || []).map((p) => p.service || p.comm).filter(Boolean))];
      m.note.textContent = services.join(" · ") || "idle";
    }

    // instance modules
    for (const i of inst) {
      const m = st.instMods.get(i.name);
      if (!m) continue;
      const gpus = gpusForInstance(i.name);
      m.el.classList.toggle("down", !i.up);
      m.led.className = "led on " + (i.up ? "green" : "red");
      m.ver.textContent = i.up ? `v${i.version || "?"}` : "OFFLINE";
      m.note.textContent = gpus.length ? `→ GPU ${gpus.join("+")}` : "";
      const rows = [];
      if (!i.up) rows.push(el("div", "no-signal", `NO SIGNAL (${i.error || "?"})`));
      else if (!(i.models || []).length) rows.push(el("div", "no-model", "NO MODEL LOADED"));
      for (const md of i.models || []) {
        const on = gpus.some((x) => active.has(x));
        const box = el("div", "model");
        const top = el("div", "model-top");
        const led = el("span", "led green" + (on ? " on" : ""));
        top.append(led, el("span", "model-name", md.name));
        const share = md.size ? Math.round((100 * (md.vram || 0)) / md.size) : null;
        const info = [md.context ? "ctx " + ktxt(md.context) : null, share != null ? `${share}% GPU` : null, gb(md.size)].filter(Boolean).join(" · ");
        const keyName = i.name + "|" + md.name;
        if (md.left_s != null) st.maxLeft[keyName] = Math.max(st.maxLeft[keyName] || 0, md.left_s);
        const frac = md.left_s == null ? 0 : md.left_s > 1e7 ? 1 : md.left_s / (st.maxLeft[keyName] || 1);
        const keep = el("div", "keep");
        const bar = el("div", "keep-bar");
        const lit = Math.ceil(clamp(frac) * 16);
        for (let k = 0; k < 16; k++) bar.append(el("i", k < lit ? "on" : ""));
        keep.append(bar, el("span", "keep-time", timeText(md.left_s)));
        box.title = [md.family, md.params, md.quant, md.vram != null ? `${gb(md.vram)} in VRAM` : null, "keep-alive left"].filter(Boolean).join(" · ");
        box.append(top, el("div", "model-info", info), keep);
        rows.push(box);
      }
      m.models.replaceChildren(...rows);
    }

    const up = inst.filter((i) => i.up).length;
    $("rail-status").textContent = !st.ok ? "NO SIGNAL FROM OLLAMP SERVER"
      : `${up}/${inst.length} INSTANCES · ${models} MODEL${models === 1 ? "" : "S"} · ${ag.length} GPU${ag.length === 1 ? "" : "S"}`;

    drawCables(active);
  }

  // ---------- patch cables ----------
  function drawCables(active) {
    const svg = $("cables");
    const rack = $("rack").getBoundingClientRect();
    const centre = (e) => { const r = e.getBoundingClientRect(); return [r.left - rack.left + r.width / 2, r.top - rack.top + r.height / 2]; };
    svg.setAttribute("viewBox", `0 0 ${rack.width} ${rack.height}`);
    const parts = [];
    const mk = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    for (const i of instances()) {
      const m = st.instMods.get(i.name);
      if (!m || !i.up || !(i.models || []).length) continue;   // a cable only while a model is loaded
      const color = css(m.color);
      const [x1, y1] = centre(m.jack);
      const gpus = gpusForInstance(i.name);
      gpus.forEach((gi, n) => {
        const g = st.gpuMods.get(gi);
        if (!g) return;
        const [x2, y2] = centre(g.jack);
        const dy = Math.abs(y1 - y2), dx = Math.abs(x1 - x2);
        const sag = 40 + dy * 0.35 + dx * 0.12 + n * 8;
        const d = `M ${x1} ${y1} C ${x1} ${y1 + 50}, ${x2} ${y2 + sag}, ${x2} ${y2}`;
        parts.push(mk("path", { d, class: "cable-shadow", transform: "translate(1.5 3)" }));
        parts.push(mk("path", { d, class: "cable", stroke: color }));
        if (active && active.has(gi) && !st.paused) parts.push(mk("path", { d, class: "cable-flow" }));
        for (const [x, y] of [[x1, y1], [x2, y2]]) parts.push(mk("circle", { cx: x, cy: y, r: 6.5, fill: color, class: "plug" }));
      });
    }
    svg.replaceChildren(...parts);
  }

  // ---------- canvas: timer and scope ----------
  const SEG = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg", "-": "g", " ": "" };
  function digit(ctx, x, y, w, h, ch, on, off) {
    const t = Math.max(2, w * 0.18), m = h / 2;
    const s = {
      a: [x + t, y, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t], g: [x + t, y + m - t / 2, w - 2 * t, t],
      f: [x, y + t, t, m - 1.5 * t], b: [x + w - t, y + t, t, m - 1.5 * t],
      e: [x, y + m + t / 2, t, m - 1.5 * t], c: [x + w - t, y + m + t / 2, t, m - 1.5 * t],
    };
    const lit = SEG[ch] || "";
    for (const k in s) {
      const isOn = lit.includes(k);
      ctx.fillStyle = isOn ? on : off;
      ctx.shadowColor = on; ctx.shadowBlur = isOn ? 6 : 0;
      ctx.fillRect(...s[k]);
    }
    ctx.shadowBlur = 0;
  }

  function drawTimer(now) {
    const { ctx, w, h } = prepare($("timer"));
    ctx.clearRect(0, 0, w, h);
    const on = css("--seg-on"), off = css("--seg-off");
    const ms = st.busySince != null ? now - st.busySince : st.lastLength;
    const blink = (st.busySince == null && st.lastLength > 0) || st.paused;
    const visible = !blink || Math.floor(now / 500) % 2 === 0;
    const s = Math.floor(ms / 1000);
    const chars = !st.ok && !st.data ? "--:--" : `${String(Math.min(99, Math.floor(s / 60))).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    const dh = Math.min(h - 4, 30), dw = dh * 0.5, gap = dw * 0.3, colon = Math.max(2, dw * 0.2);
    const total = dw * 4 + gap * 4 + colon;
    let x = (w - total) / 2;
    const y = (h - dh) / 2;
    for (const ch of chars) {
      if (ch === ":") {
        ctx.fillStyle = visible ? on : off;
        ctx.fillRect(x, y + dh * 0.28, colon, colon);
        ctx.fillRect(x, y + dh * 0.64, colon, colon);
        x += colon + gap;
      } else {
        digit(ctx, x, y, dw, dh, ch, visible ? on : off, off);
        x += dw + gap;
      }
    }
  }

  function graticule(ctx, w, h) {
    ctx.fillStyle = css("--screen-bg");
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = css("--phosphor-dim");
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 10; i++) { const x = Math.round((w * i) / 10) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let i = 1; i < 8; i++) { const y = Math.round((h * i) / 8) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  function drawScope(now) {
    const { ctx, w, h } = prepare($("vis"));
    graticule(ctx, w, h);
    const gpus = selectedGpus();
    if (st.mode === 2 || !gpus.length) return;
    ctx.save();
    if (st.mode === 0) {
      const step = 5, total = Math.floor((w + 1) / step);
      const per = Math.max(1, Math.floor((total - (gpus.length - 1)) / gpus.length));
      let x = 0;
      gpus.forEach((g, gi) => {
        const color = gpuColor(g.index);
        const hist = (st.hist[g.index] || { util: [] }).util.slice(-per);
        while (hist.length < per) hist.unshift(0);
        ctx.shadowColor = color; ctx.shadowBlur = 6;
        for (let i = 0; i < per; i++) {
          const key = gi * 1000 + i;
          const target = (hist[i] / 100) * (h - 4);
          const cur = st.bars.get(key) || 0;
          const next = cur + (target - cur) * 0.2;
          st.bars.set(key, next);
          const peak = Math.max((st.peaks.get(key) || 0) - 0.4, next);
          st.peaks.set(key, peak);
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = color;
          ctx.fillRect(x, h - next, step - 2, next);
          if (peak > 1) { ctx.globalAlpha = 1; ctx.fillRect(x, h - peak - 2, step - 2, 2); }
          x += step;
        }
        x += step;
      });
    } else {
      const frac = clamp((now - st.sampleTime) / 1000);
      const n = 60, dx = w / (n - 1);
      for (const g of gpus) {
        const hist = (st.hist[g.index] || { watts: [] }).watts.slice(-(n + 1));
        if (hist.length < 2) continue;
        const color = gpuColor(g.index);
        ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
        ctx.lineWidth = 2;
        ctx.beginPath();
        hist.forEach((v, i) => {
          const xx = w - (hist.length - 1 - i + frac) * dx;
          const yy = h - 4 - v * (h - 8);
          i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
        });
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function loop(now) {
    if (st.colors) { drawTimer(now); drawScope(now); }
    requestAnimationFrame(loop);
  }

  // ---------- controls ----------
  function switchGpu() {
    const opts = [null, ...allGpus().map((g) => g.index)];
    st.gpu = opts[(opts.indexOf(st.gpu) + 1) % opts.length];
    st.bars.clear(); st.peaks.clear();
    save("gpu", st.gpu == null ? "" : st.gpu);
    render();
  }
  function switchMode() { st.mode = (st.mode + 1) % MODES.length; save("mode", st.mode); render(); }
  function setMono(on) {
    st.mono = on;
    if (on) document.documentElement.dataset.theme = "mono";
    else delete document.documentElement.dataset.theme;
    $("led-mono").classList.toggle("on", on);
    save("mono", on ? "1" : "");
    readColors();
    render();
  }
  function hold() { st.paused = !st.paused; render(); }
  function reset() {
    st.hist = {}; st.bars.clear(); st.peaks.clear(); st.maxLeft = {};
    st.busySince = null; st.lastLength = 0;
    render();
  }

  $("b-hold").addEventListener("click", hold);
  $("b-reset").addEventListener("click", reset);
  $("b-gpu").addEventListener("click", switchGpu);
  $("b-vis").addEventListener("click", switchMode);
  $("b-mono").addEventListener("click", () => setMono(!st.mono));
  $("vis").addEventListener("click", switchMode);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest("button")) return;
    const k = e.key.toLowerCase();
    if (k === " ") { e.preventDefault(); hold(); }
    else if (k === "r") reset();
    else if (k === "g") switchGpu();
    else if (k === "v") switchMode();
    else if (k === "m") setMono(!st.mono);
  });
  if (window.ResizeObserver) new ResizeObserver(() => drawCables(new Set(allGpus().filter(busy).map((g) => g.index)))).observe($("rack"));

  // ---------- start ----------
  const savedMode = Number(load("mode"));
  if (savedMode >= 0 && savedMode < MODES.length) st.mode = savedMode;
  const savedGpu = load("gpu");
  if (savedGpu) st.gpu = Number(savedGpu);
  if (load("mono") === "1") setMono(true);
  readColors();
  render();
  fetchStatus();
  requestAnimationFrame(loop);
})();
