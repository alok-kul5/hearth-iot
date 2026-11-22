// The living plan: a canvas drawn over the floor plan that shows what the sensors measure.
//
//   CO2 and VOCs   a haze of slow dots in the room, denser as the reading climbs, red once it is over the limit
//   PM2.5          smoke rising off the hob in the kitchen while the level is up
//   Ventilation    the fan in the hallway spins and air streams out of every room towards it
//   Leak           ripples spreading from under the bathroom sink
//   The light      a glow in the living room, in the light's real colour and brightness
//   Motion         footsteps crossing the hallway
//
// It reads the dashboard's own `state`, so it shows exactly what the numbers say. It pauses when the plan is
// off screen or the tab is hidden, and draws one still frame when the visitor prefers reduced motion.
(() => {
  "use strict";
  const VB = { x: -6, y: -6, w: 612, h: 338 };        // the plan SVG's viewBox
  const HOB = { x: 452, y: 116 };                       // where the kitchen smoke rises from (clear of the text)
  const SINK = { x: 572, y: 104 };                      // under the bathroom sink
  const LAMP = { x: 250, y: 44 };                       // the living-room light
  const FAN = () => { const r = ROOMS.hallway; return { x: r.x + r.w - 74, y: r.y + r.h / 2 }; };
  const OUTDOOR = 420;

  const svg = document.getElementById("plan");
  const wrap = svg.parentElement;
  const canvas = document.createElement("canvas");
  canvas.className = "living";
  canvas.setAttribute("aria-hidden", "true");
  wrap.append(canvas);
  const ctx = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  let scale = 1, dpr = 1, visible = true, last = performance.now(), fanAngle = 0, raf = 0;
  const haze = { living_room: [], bedroom: [] };
  const smoke = [], flow = [], ripples = [], steps = [];
  let lightPreview = null;  // { kelvin, brightness } while the visitor scrubs the day strip

  const val = (id) => state.sensors.get(id)?.last_value ?? null;
  const rand = (a, b) => a + Math.random() * (b - a);
  const inset = (r, m) => ({ x: r.x + m, y: r.y + m, w: r.w - 2 * m, h: r.h - 2 * m });
  // Each room's name, reading and notes sit in its top-left corner; nothing drifts over them.
  const TEXT = { w: 186, h: 116 };
  const inText = (room, x, y) => { const r = ROOMS[room]; return x < r.x + TEXT.w && y < r.y + TEXT.h; };
  const roomOfPoint = (x, y) => Object.keys(ROOMS).find((k) => { const r = ROOMS[k]; return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; });

  function resize() {
    const box = svg.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;
    scale = box.width / VB.w;
  }
  const toPx = (x, y) => [(x - VB.x) * scale, (y - VB.y) * scale];

  /* ── How much of each effect the readings call for ─── */
  function hazeTarget(room) {
    const co2 = val(room === "living_room" ? "co2-living" : "co2-bedroom");
    const voc = room === "living_room" ? val("voc-living") : null;
    let n = co2 == null ? 0 : (co2 - OUTDOOR - 60) / 22;
    if (voc != null) n += (voc - 180) / 30;
    return Math.max(0, Math.min(70, Math.round(n)));
  }
  const overLimit = (room) => {
    const ids = room === "living_room" ? ["co2-living", "voc-living"] : ["co2-bedroom"];
    return ids.some((id) => alertingSensors().has(id));
  };
  const ervOn = () => val("erv-main") === 1;

  function spawnHaze(room) {
    const r = inset(ROOMS[room], 14);
    let x, y;
    do { x = rand(r.x, r.x + r.w); y = rand(r.y + 10, r.y + r.h); } while (inText(room, x, y));
    return { x, y, vx: rand(-6, 6), vy: rand(-6, 6), r: rand(1.4, 3), a: 0 };
  }

  /* ── One step of the simulation ─────────────────────── */
  function step(dt) {
    const fan = FAN(), on = ervOn();
    fanAngle += dt * (on ? 9 : 0.4);

    for (const room of Object.keys(haze)) {
      const list = haze[room], want = hazeTarget(room), r = inset(ROOMS[room], 10);
      while (list.length < want) list.push(spawnHaze(room));
      list.forEach((p, i) => {
        const leaving = i >= want;
        p.a = Math.min(1, Math.max(0, p.a + (leaving ? -dt * 0.8 : dt * 0.6)));
        p.vx += rand(-14, 14) * dt; p.vy += rand(-14, 14) * dt;
        if (on) { p.vx += (fan.x - p.x) * dt * 0.05; p.vy += (fan.y - p.y) * dt * 0.05; }  // pulled out by the ERV
        p.vx *= 0.98; p.vy *= 0.98;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < r.x || p.x > r.x + r.w) { p.vx *= -1; p.x = Math.min(r.x + r.w, Math.max(r.x, p.x)); }
        if (p.y < r.y || p.y > r.y + r.h) { p.vy *= -1; p.y = Math.min(r.y + r.h, Math.max(r.y, p.y)); }
        if (inText(room, p.x, p.y)) {  // push it back out of the text corner, the short way
          const R = ROOMS[room], dx = R.x + TEXT.w - p.x, dy = R.y + TEXT.h - p.y;
          if (dx < dy) { p.x = R.x + TEXT.w; p.vx = Math.abs(p.vx); } else { p.y = R.y + TEXT.h; p.vy = Math.abs(p.vy); }
        }
      });
      haze[room] = list.filter((p, i) => i < want || p.a > 0);
    }

    const pm = val("pm25-kitchen") ?? 0;
    const smokeRate = Math.max(0, (pm - 12) / 3);             // puffs per second
    if (Math.random() < smokeRate * dt) smoke.push({ x: HOB.x + rand(-6, 8), y: HOB.y, vx: rand(-2, 4), vy: rand(-26, -14), r: rand(3, 5), life: 0, max: rand(1.8, 2.8) });
    for (const p of smoke) {
      p.life += dt; p.r += dt * 3;
      if (p.x < 440 && p.y < 128) { p.x = 440; p.vx = Math.abs(p.vx); }  // the kitchen is narrow: smoke keeps to its right edge
      if (on) { p.vx += (fan.x - p.x) * dt * 0.04; p.vy += (fan.y - p.y) * dt * 0.06; }
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = smoke.length - 1; i >= 0; i--) if (smoke[i].life > smoke[i].max) smoke.splice(i, 1);

    if (on && Math.random() < dt * 14) {
      const rooms = ["living_room", "bedroom", "kitchen", "bathroom", "entrance"];
      const room = rooms[Math.floor(Math.random() * rooms.length)], r = inset(ROOMS[room], 20);
      const x = rand(r.x, r.x + r.w), y = rand(r.y, r.y + r.h);
      if (!inText(room, x, y)) flow.push({ x, y, t: 0 });
    }
    for (const p of flow) {
      p.t += dt;
      const dx = fan.x - p.x, dy = fan.y - p.y, d = Math.hypot(dx, dy) || 1;
      const speed = 60 + 40 * Math.min(1, p.t);
      p.px = p.x; p.py = p.y;
      p.x += (dx / d) * speed * dt; p.y += (dy / d) * speed * dt;
      const room = roomOfPoint(p.x, p.y);
      p.done = d < 8 || (room && room !== "hallway" && inText(room, p.x, p.y));
    }
    for (let i = flow.length - 1; i >= 0; i--) if (flow[i].done || flow[i].t > 6) flow.splice(i, 1);

    if (val("leak-bathroom") === 1 && (ripples.length === 0 || ripples[ripples.length - 1].t > 0.7)) ripples.push({ t: 0 });
    for (const r of ripples) r.t += dt;
    while (ripples.length && ripples[0].t > 2.4) ripples.shift();

    if (val("motion-hallway") === 1 && (steps.length === 0 || steps[steps.length - 1].t > 0.32)) {
      const h = ROOMS.hallway, n = steps.length;
      steps.push({ x: h.x + 30 + ((n * 26) % (h.w - 140)), y: h.y + h.h / 2 + (n % 2 ? 6 : -6), t: 0 });
    }
    for (const s of steps) s.t += dt;
    while (steps.length && steps[0].t > 1.6) steps.shift();
  }

  /* ── Drawing ────────────────────────────────────────── */
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // The light: a soft pool of its own colour in the living room.
    const kelvin = lightPreview?.kelvin ?? val("light-living-kelvin");
    const level = lightPreview?.brightness ?? val("light-living-level");
    if (kelvin != null && level != null && level > 0) {
      const [lx, ly] = toPx(LAMP.x, LAMP.y), R = (60 + level * 1.6) * scale;
      const lr = ROOMS.living_room, [rx, ry] = toPx(lr.x, lr.y);
      ctx.save();
      ctx.beginPath(); ctx.roundRect(rx, ry, lr.w * scale, lr.h * scale, 14 * scale); ctx.clip();
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, R);
      const rgb = kelvinRGB(kelvin).replace("rgb(", "").replace(")", "");
      g.addColorStop(0, `rgba(${rgb}, ${0.18 + level / 260})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g; ctx.fillRect(rx, ry, lr.w * scale, lr.h * scale);
      ctx.restore();
    }

    for (const room of Object.keys(haze)) {
      const red = overLimit(room);
      ctx.fillStyle = red ? "rgba(196, 36, 42, 0.42)" : "rgba(29, 46, 48, 0.22)";
      for (const p of haze[room]) {
        const [x, y] = toPx(p.x, p.y);
        ctx.globalAlpha = p.a;
        ctx.beginPath(); ctx.arc(x, y, p.r * scale, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    for (const p of smoke) {
      const [x, y] = toPx(p.x, p.y), k = p.life / p.max;
      ctx.fillStyle = `rgba(79, 95, 98, ${0.22 * (1 - k)})`;
      ctx.beginPath(); ctx.arc(x, y, p.r * scale, 0, Math.PI * 2); ctx.fill();
    }

    ctx.strokeStyle = "rgba(15, 106, 108, 0.6)"; ctx.lineWidth = 1.5 * scale; ctx.lineCap = "round";
    for (const p of flow) {
      if (p.px == null) continue;
      const [x0, y0] = toPx(p.px - (p.x - p.px) * 3, p.py - (p.y - p.py) * 3), [x1, y1] = toPx(p.x, p.y);
      ctx.globalAlpha = Math.min(1, p.t * 3);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // The ERV fan: three blades in a ring.
    const f = FAN(), [fx, fy] = toPx(f.x, f.y), on = ervOn();
    ctx.save(); ctx.translate(fx, fy);
    ctx.strokeStyle = on ? "#1d2e30" : "#b7c1bc"; ctx.lineWidth = 1.2 * scale;
    ctx.beginPath(); ctx.arc(0, 0, 13 * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.rotate(fanAngle);
    ctx.fillStyle = on ? "#1d2e30" : "#b7c1bc";
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI * 2) / 3);
      ctx.beginPath(); ctx.ellipse(0, -6 * scale, 3.2 * scale, 6 * scale, 0.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    const [sx, sy] = toPx(SINK.x, SINK.y);
    const bath = ROOMS.bathroom, [bx, by] = toPx(bath.x, bath.y);
    ctx.save();  // the ripples stay inside the bathroom
    ctx.beginPath(); ctx.roundRect(bx, by, bath.w * scale, bath.h * scale, 14 * scale); ctx.clip();
    for (const r of ripples) {
      const k = r.t / 2.4;
      ctx.strokeStyle = `rgba(15, 106, 108, ${0.7 * (1 - k)})`; ctx.lineWidth = 1.5 * scale;
      ctx.beginPath(); ctx.ellipse(sx, sy, (4 + k * 34) * scale, (2 + k * 14) * scale, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    for (const s of steps) {
      const [x, y] = toPx(s.x, s.y);
      ctx.fillStyle = `rgba(29, 46, 48, ${0.35 * (1 - s.t / 1.6)})`;
      ctx.beginPath(); ctx.ellipse(x, y, 3 * scale, 2 * scale, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    draw();
    if (visible && !document.hidden && !reduced.matches) raf = requestAnimationFrame(frame);
  }
  function start() {
    if (reduced.matches) { for (let i = 0; i < 120; i++) step(0.05); draw(); return; }  // one settled still
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  new ResizeObserver(() => { resize(); draw(); }).observe(svg);
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible) start(); }).observe(wrap);
  document.addEventListener("visibilitychange", () => !document.hidden && start());
  reduced.addEventListener?.("change", start);
  setInterval(() => reduced.matches && start(), 2000);  // reduced motion: refresh the still as readings change

  window.livingPlan = { preview(p) { lightPreview = p; if (reduced.matches) draw(); } };
  resize();
  start();
})();
