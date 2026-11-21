// Hearth live demo: the whole stack, simulated in the browser.
//
// On GitHub Pages there is no Mosquitto broker and no FastAPI backend, so this file
// stands in for both. It ports the sensor simulator (simulator/sensors.py), the rule
// engine (backend/app/rules.py), the automations (backend/app/automations.py) and the
// circadian schedule (backend/app/circadian.py), then answers the dashboard's /api/*
// requests and its /ws live feed from memory. The dashboard code (app.js) is the same
// file the real backend serves. Rules and lighting keyframes are read from
// demo-data.json, which the build script generates from rules.yaml and circadian.py.
(() => {
  "use strict";

  /* ── Random helpers ─────────────────────────────────── */
  const rand = Math.random;
  const gauss = (sd) => sd * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const uniform = (a, b) => a + rand() * (b - a);
  const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const localHour = (t) => { const d = new Date(t * 1000); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };

  const TICK = 2;             // seconds between readings, as in the real simulator
  const OUTDOOR_CO2 = 420;
  const MEALS = [[7, 8.5], [12.5, 14], [19, 21]];
  const SCALE = 8;            // events happen more often than in a real home, so the demo has something to show

  /* ── Household: people, cooking, ventilation, the light ─ */
  const home = {
    ventilation: false, lightKelvin: 2700, lightLevel: 0, cookingLeft: 0, guestsLeft: 0,
    get cooking() { return this.cookingLeft > 0; },
    occupants(room, hour) {
      const asleep = hour >= 23 || hour < 7;
      const guests = this.guestsLeft > 0 ? 4 : 0;
      if (room === "bedroom") return asleep ? 2 : 0;
      if (room === "living_room") return asleep ? 0 : (hour >= 18 ? 3 : 1) + guests;
      if (room === "kitchen") return this.cooking ? 1 : 0;
      return 0;
    },
    step(t) {
      const hour = localHour(t);
      if (this.cookingLeft > 0) this.cookingLeft--;
      else {
        const chance = MEALS.some(([a, b]) => hour >= a && hour < b) ? 0.01 : 0.0005;
        if (rand() < Math.min(1, chance * SCALE)) this.cookingLeft = randint(60, 240);
      }
      if (this.guestsLeft > 0) this.guestsLeft--;
      else if (hour >= 9 && hour < 23 && rand() < 0.0008 * SCALE) this.guestsLeft = randint(150, 400);
    },
    command(device, payload) {
      if (device === "erv-main") this.ventilation = payload === "ON";
      if (device === "light-living") {
        const c = JSON.parse(payload);
        this.lightKelvin = clamp(c.color_temp_k, 1500, 6500);
        this.lightLevel = clamp(c.brightness, 0, 100);
      }
    },
  };

  /* ── Sensors (same behaviour as simulator/sensors.py) ── */
  function temperature(base, amplitude = 2, fault = 0.002) {
    let drift = 0, faultLeft = 0;
    return (t) => {
      const hour = (t / 3600) % 24;
      drift = clamp(drift + gauss(0.05), -1.5, 1.5);
      let v = base + amplitude * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + drift + gauss(0.1);
      if (faultLeft === 0 && rand() < fault) faultLeft = randint(8, 20);
      if (faultLeft > 0) { faultLeft--; v += 12; }
      return round(v, 2);
    };
  }
  function humidity(base, fault = 0.002) {
    let level = base, faultLeft = 0;
    return () => {
      level += (base - level) * 0.05 + gauss(0.6);
      let v = level;
      if (faultLeft === 0 && rand() < fault) faultLeft = randint(8, 20);
      if (faultLeft > 0) { faultLeft--; v += 30; }
      return round(clamp(v, 0, 100), 1);
    };
  }
  function motion(chance = 0.08) {
    let left = 0;
    return () => {
      if (left > 0) { left--; return 1; }
      if (rand() < chance) { left = randint(1, 4); return 1; }
      return 0;
    };
  }
  function door(openChance = 0.03, leftOpen = 0.05) {
    let left = 0;
    return () => {
      if (left > 0) { left--; return 1; }
      if (rand() < openChance) { left = rand() < leftOpen ? randint(40, 80) : randint(1, 3); return 1; }
      return 0;
    };
  }
  function co2(room) {
    let level = OUTDOOR_CO2 + 150;
    return (t) => {
      const people = home.occupants(room, localHour(t));
      const k = 0.002 + (home.ventilation ? 0.02 : 0);
      level = Math.max(OUTDOOR_CO2 - 20, level + people - (level - OUTDOOR_CO2) * k + gauss(2));
      return Math.round(level);
    };
  }
  function pm25(base = 7) {
    let level = base;
    return () => {
      level += (base - level) * (0.02 + (home.ventilation ? 0.05 : 0)) + gauss(0.3);
      if (home.cooking) level += uniform(0.5, 2.5);
      level = Math.max(1, level);
      return round(level, 1);
    };
  }
  function voc(room, base = 110, fault = 0.001) {
    let level = base;
    return (t) => {
      const target = base + 35 * home.occupants(room, localHour(t)) + (home.cooking ? 180 : 0);
      level += (target - level) * (0.01 + (home.ventilation ? 0.03 : 0)) + gauss(4);
      if (rand() < fault) level += uniform(500, 900);
      level = Math.max(20, level);
      return Math.round(level);
    };
  }
  function tds(base = 85, fault = 0.001) {
    let level = base, faultLeft = 0;
    return () => {
      if (faultLeft === 0 && rand() < fault) faultLeft = randint(60, 150);
      const target = faultLeft > 0 ? 380 : base;
      if (faultLeft > 0) faultLeft--;
      level += (target - level) * 0.08 + gauss(1.5);
      return Math.round(Math.max(0, level));
    };
  }
  function leak(fault = 0.0005) {
    let wet = 0;
    return () => {
      if (wet === 0 && rand() < fault) wet = randint(30, 120);
      if (wet > 0) { wet--; return 1; }
      return 0;
    };
  }

  const S = (sensor_id, room, type, unit, read) => ({ sensor_id, room, type, unit, read });
  const SENSORS = [
    S("temp-living", "living_room", "temperature", "°C", temperature(21.5, 2, 0.002)),
    S("hum-living", "living_room", "humidity", "%", humidity(45, 0.002)),
    S("co2-living", "living_room", "co2", "ppm", co2("living_room")),
    S("voc-living", "living_room", "voc", "ppb", voc("living_room", 110, 0.001 * SCALE)),
    S("light-living-kelvin", "living_room", "color_temp", "K", () => Math.round(home.lightKelvin)),
    S("light-living-level", "living_room", "brightness", "%", () => Math.round(home.lightLevel)),
    S("temp-bedroom", "bedroom", "temperature", "°C", temperature(19.5, 1.5, 0.002)),
    S("co2-bedroom", "bedroom", "co2", "ppm", co2("bedroom")),
    S("hum-bathroom", "bathroom", "humidity", "%", humidity(55, 0.002)),
    S("leak-bathroom", "bathroom", "leak", "bool", leak(0.0005 * SCALE)),
    S("temp-kitchen", "kitchen", "temperature", "°C", temperature(22.5, 2.5, 0.002)),
    S("pm25-kitchen", "kitchen", "pm25", "µg/m³", pm25()),
    S("tds-kitchen", "kitchen", "tds", "ppm", tds(85, 0.001 * SCALE)),
    S("motion-hallway", "hallway", "motion", "bool", motion()),
    S("erv-main", "hallway", "ventilation", "bool", () => (home.ventilation ? 1 : 0)),
    S("door-front", "entrance", "door", "bool", door()),
    S("door-back", "kitchen", "door", "bool", door(0.015)),
  ];

  /* ── Rule engine (backend/app/rules.py) ─────────────── */
  const OPS = { ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b, "==": (a, b) => a === b };
  const pyFloat = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  let RULES = [], STALE = 30, KEYFRAMES = [];
  const since = new Map(), open = new Set();

  function evaluate(r) {
    const events = [];
    for (const rule of RULES) {
      if (rule.sensor_type !== r.type) continue;
      const k = `${r.sensor_id}:${rule.name}`;
      const limit = rule.clear_at ?? rule.threshold;
      if (open.has(k) && OPS[rule.op](r.value, limit)) continue;
      if (!open.has(k) && OPS[rule.op](r.value, rule.threshold)) {
        if (!since.has(k)) since.set(k, r.ts);
        if (r.ts - since.get(k) >= (rule.for_seconds ?? 0)) {
          open.add(k);
          const message = (rule.message ?? "{value} breached {threshold}").replace("{value}", pyFloat(r.value)).replace("{threshold}", rule.threshold);
          events.push({ kind: "opened", key: k, rule: rule.name, sensor_id: r.sensor_id, severity: rule.severity ?? "warning", message, value: r.value, ts: r.ts });
        }
      } else {
        since.delete(k);
        if (open.has(k)) {
          open.delete(k);
          events.push({ kind: "resolved", key: k, rule: rule.name, sensor_id: r.sensor_id, severity: rule.severity ?? "warning", message: "Back in normal range", value: r.value, ts: r.ts });
        }
      }
    }
    return events;
  }

  /* ── Automations (backend/app/automations.py) ───────── */
  const demand = new Map();  // device -> set of open alert keys that want it on
  function applyAutomation(e) {
    const rule = RULES.find((r) => r.name === e.rule);
    let changed = false;
    for (const device of rule?.activates ?? []) {
      const keys = demand.get(device);
      const wasOn = keys.size > 0;
      if (e.kind === "opened") keys.add(e.key); else keys.delete(e.key);
      if ((keys.size > 0) !== wasOn) { home.command(device, keys.size ? "ON" : "OFF"); changed = true; }
    }
    return changed;
  }
  const automationState = () => Object.fromEntries([...demand].map(([d, keys]) => [d, { state: keys.size ? "ON" : "OFF", because: [...keys].sort() }]));

  /* ── Circadian light (backend/app/circadian.py) ─────── */
  function setpoint(hour) {
    hour %= 24;
    for (let i = 0; i < KEYFRAMES.length - 1; i++) {
      const [h0, k0, b0] = KEYFRAMES[i], [h1, k1, b1] = KEYFRAMES[i + 1];
      if (hour >= h0 && hour <= h1) {
        const f = (hour - h0) / (h1 - h0);
        return [Math.round((k0 + (k1 - k0) * f) / 50) * 50, Math.round(b0 + (b1 - b0) * f)];
      }
    }
    return [KEYFRAMES[0][1], KEYFRAMES[0][2]];
  }
  let lastSetpoint = "";
  function circadianTick(t) {
    const [kelvin, brightness] = setpoint(localHour(t));
    const cmd = JSON.stringify({ color_temp_k: kelvin, brightness });
    if (cmd !== lastSetpoint) { lastSetpoint = cmd; home.command("light-living", cmd); }
  }

  /* ── Storage (backend/app/storage.py, in memory) ────── */
  const latest = new Map(), history = new Map(), alerts = [];
  let alertId = 0, received = 0;
  function store(r) {
    latest.set(r.sensor_id, { sensor_id: r.sensor_id, room: r.room, type: r.type, unit: r.unit, last_value: r.value, last_ts: r.ts });
    const h = history.get(r.sensor_id) ?? [];
    h.push({ ts: r.ts, value: r.value });
    while (h.length && h[0].ts < r.ts - 6 * 3600) h.shift();
    history.set(r.sensor_id, h);
  }
  function applyAlert(e) {
    if (e.kind === "opened") {
      const row = { id: ++alertId, key: e.key, rule: e.rule, sensor_id: e.sensor_id, severity: e.severity, message: e.message, value: e.value, opened_at: e.ts, resolved_at: null };
      alerts.push(row);
      return row;
    }
    const row = [...alerts].reverse().find((a) => a.key === e.key && a.resolved_at == null);
    if (row) row.resolved_at = e.ts;
    return row;
  }
  function historyOf(id, minutes, maxPoints = 300) {
    const pts = (history.get(id) ?? []).filter((p) => p.ts >= Date.now() / 1000 - minutes * 60);
    if (pts.length <= maxPoints) return pts;
    const lo = pts[0].ts, bucket = (pts[pts.length - 1].ts - lo) / maxPoints || 1e-9, out = new Map();
    for (const p of pts) {
      const b = Math.floor((p.ts - lo) / bucket), acc = out.get(b) ?? { ts: 0, value: 0, n: 0 };
      acc.ts += p.ts; acc.value += p.value; acc.n++; out.set(b, acc);
    }
    return [...out.values()].map((a) => ({ ts: a.ts / a.n, value: round(a.value / a.n, 3) }));
  }

  /* ── Ingest: one tick of the whole home ─────────────── */
  const sockets = new Set();
  const broadcast = (msg) => { const data = JSON.stringify(msg); sockets.forEach((s) => s.onmessage?.({ data })); };
  function tick(t, live) {
    home.step(t);
    circadianTick(t);
    for (const s of SENSORS) {
      const r = { sensor_id: s.sensor_id, room: s.room, type: s.type, value: s.read(t), unit: s.unit, ts: t };
      received++;
      store(r);
      if (live) broadcast({ kind: "reading", data: r });
      for (const e of evaluate(r)) {
        const row = applyAlert(e);
        if (live && row) broadcast({ kind: "alert", event: e.kind, data: { ...row } });
        if (applyAutomation(e) && live) broadcast({ kind: "automation", data: automationState() });
      }
    }
  }

  /* ── Fake backend: /api/* and /ws ───────────────────── */
  const NOT_FOUND = Symbol("404");
  function route(path, q) {
    const now = Date.now() / 1000;
    if (path === "/api/health") return { status: "ok", mqtt_connected: false, demo: true, messages_received: received, messages_rejected: 0, readings_stored: [...history.values()].reduce((n, h) => n + h.length, 0) };
    if (path === "/api/sensors") return [...latest.values()].sort((a, b) => a.room.localeCompare(b.room) || a.sensor_id.localeCompare(b.sensor_id)).map((s) => ({ ...s, online: now - s.last_ts <= STALE }));
    const m = path.match(/^\/api\/sensors\/([^/]+)\/history$/);
    if (m) return latest.has(m[1]) ? historyOf(m[1], Number(q.get("minutes") ?? 15)) : NOT_FOUND;
    if (path === "/api/alerts") {
      const rows = alerts.filter((a) => q.get("active") !== "true" || a.resolved_at == null);
      return rows.sort((a, b) => b.opened_at - a.opened_at).slice(0, Number(q.get("limit") ?? 50)).map((a) => ({ ...a }));
    }
    if (path === "/api/rules") return { stale_after_seconds: STALE, rules: RULES };
    if (path === "/api/automations") return automationState();
    if (path === "/api/circadian") {
      const hour = localHour(now), [kelvin, brightness] = setpoint(hour);
      const schedule = [];
      for (let mins = 0; mins <= 24 * 60; mins += 30) { const [k, b] = setpoint(mins / 60); schedule.push({ hour: mins / 60, kelvin: k, brightness: b }); }
      return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local time", hour: round(hour, 3), target: { kelvin, brightness }, schedule };
    }
    return NOT_FOUND;
  }

  const realFetch = window.fetch.bind(window);
  const ready = realFetch(new URL("demo-data.json", document.currentScript.src)).then((r) => r.json()).then((d) => {
    RULES = d.rules.rules.map((r) => ({ for_seconds: 0, severity: "warning", clear_at: null, activates: [], ...r }));
    STALE = d.rules.stale_after_seconds ?? 30;
    KEYFRAMES = d.keyframes;
    for (const r of RULES) for (const dev of r.activates) demand.set(dev, new Set());
    // Replay the last 20 minutes so the charts have history, with dinner on the stove 10 minutes ago.
    const now = Math.floor(Date.now() / 1000), start = now - 20 * 60;
    for (let t = start; t <= now; t += TICK) {
      if (t === start + 300) home.cookingLeft = 150;
      tick(t, false);
    }
    setInterval(() => tick(Date.now() / 1000, true), TICK * 1000);
  });

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const at = url.pathname.indexOf("/api/");
    if (at < 0) return realFetch(input, init);
    await ready;
    const body = route(url.pathname.slice(at), url.searchParams);
    if (body === NOT_FOUND) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  window.WebSocket = class DemoSocket {
    constructor() {
      this.readyState = 0;
      ready.then(() => { this.readyState = 1; sockets.add(this); this.onopen?.({}); });
    }
    send() {}
    close() { sockets.delete(this); this.readyState = 3; }
  };

  /* ── A note saying what this page is ────────────────── */
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = `.demo-note { margin-top: 8px; font-size: 13px; line-height: 20px; color: var(--muted); }
      .demo-note strong { color: var(--text); font-weight: 500; }
      .demo-note a { color: var(--text); text-decoration: underline; text-decoration-color: var(--control); text-underline-offset: 3px; }
      .demo-note a:hover { text-decoration-color: var(--text); }`;
    document.head.append(style);
    const note = document.createElement("p");
    note.className = "demo-note";
    note.innerHTML = `<strong>Live demo, simulated in your browser.</strong> The real version runs on MQTT, Mosquitto and FastAPI: <a href="https://github.com/alok-kul5/hearth-iot">see the code on GitHub</a>.`;
    document.querySelector(".title-row > div")?.append(note);
    const via = document.getElementById("via");
    if (via) via.textContent = "Simulated in this browser";
    document.title = "Hearth · Live demo";
  });
})();
