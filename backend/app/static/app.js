// Home Sensors dashboard: loads state over REST, then follows the WebSocket feed.

const $ = (s) => document.querySelector(s);
const ROOMS = {
  // The flat, drawn to the plan's 600 x 326 viewBox. 8px gaps are the walls.
  living_room: { label: "Living room", x: 0, y: 0, w: 296, h: 186 },
  kitchen: { label: "Kitchen", x: 304, y: 0, w: 166, h: 124 },
  bathroom: { label: "Bathroom", x: 478, y: 0, w: 122, h: 124 },
  hallway: { label: "Hallway", x: 304, y: 132, w: 296, h: 54 },
  bedroom: { label: "Bedroom", x: 0, y: 194, w: 296, h: 132 },
  entrance: { label: "Entrance", x: 304, y: 194, w: 296, h: 132 },
};
// Where each door sits on its room's outer wall.
const DOORS = {
  "door-front": { x1: 530, y1: 324, x2: 590, y2: 324, hinge: [530, 324], swing: -1 },
  "door-back": { x1: 462, y1: 2, x2: 414, y2: 2, hinge: [462, 2], swing: -1 },
};
const TYPE_LABEL = {
  temperature: "temperature", humidity: "humidity", motion: "motion", door: "door",
  co2: "CO₂", pm25: "PM2.5", voc: "VOC", tds: "water TDS", leak: "leak sensor",
  ventilation: "ventilation", color_temp: "light colour", brightness: "light level",
};
const UNIT = { temperature: "°C", humidity: "%", co2: "ppm", pm25: "µg/m³", voc: "ppb", tds: "ppm", color_temp: "K", brightness: "%" };
const DEC = { co2: 0, voc: 0, tds: 0, color_temp: 0, brightness: 0 };   // decimals shown; 1 for everything else
const BINARY = { door: ["Open", "Closed"], motion: ["Motion", "Clear"], leak: ["Wet", "Dry"], ventilation: ["On", "Off"] };
const decOf = (type) => DEC[type] ?? 1;

const state = {
  sensors: new Map(),
  active: new Map(),     // alert key -> alert row
  log: [],
  rules: { rules: [], stale_after_seconds: 30 },
  selected: null,
  minutes: 15,
  points: [],
  messages: [],          // timestamps of live readings, for the rate
  automations: {},       // device -> { state, because: [alert keys] }
  circadian: null,       // the light's schedule from /api/circadian
};

const time = (ts, sec = false) =>
  new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}) });
const dur = (s) => {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
};
const ago = (ts) => dur(Date.now() / 1000 - ts) + " ago";
const roomOf = (s) => ROOMS[s.room]?.label ?? s.room.replace(/_/g, " ");
const isBinary = (s) => s.type in BINARY;
const fmtValue = (s, v = s.last_value) => {
  if (v == null) return { text: "–", unit: "" };
  if (BINARY[s.type]) return { text: BINARY[s.type][v ? 0 : 1], unit: "" };
  return { text: v.toFixed(decOf(s.type)), unit: UNIT[s.type] ?? s.unit };
};
const sensorName = (s) => {
  if (s.type === "door") return s.sensor_id === "door-front" ? "Front door" : "Back door";
  if (s.type === "ventilation") return "Ventilation (ERV)";
  return `${roomOf(s)} ${TYPE_LABEL[s.type] ?? s.type}`;
};
const alertingSensors = () => new Set([...state.active.values()].map((a) => a.sensor_id));
// Alert text written from the rule and the reading, so the screen never shows the raw 2-decimal log message.
function alertText(a, withValue = true) {
  const s = state.sensors.get(a.sensor_id);
  if (a.rule === "sensor_offline") return a.resolved_at ? "Went silent" : `No reading for over ${state.rules.stale_after_seconds} s`;
  const rule = state.rules.rules.find((r) => r.name === a.rule);
  if (s?.type === "door" || rule?.sensor_type === "door") return "Left open for over a minute";
  if (rule?.sensor_type === "leak") return "Water detected";
  if (rule && a.value != null) {
    const unit = UNIT[rule.sensor_type] ?? "";
    let where = `${rule.op.startsWith(">") ? "above" : "below"} the ${rule.threshold} ${unit} limit`;
    if (rule.activates?.length) where += ", ventilation on";
    return withValue ? `${a.value.toFixed(decOf(rule.sensor_type))} ${unit}, ${where}` : where.charAt(0).toUpperCase() + where.slice(1);
  }
  return a.message;
}
const readingText = (a) => {
  const s = state.sensors.get(a.sensor_id);
  if (a.value == null || !s) return "–";
  const v = fmtValue(s, a.value);
  return `${v.text}${v.unit ? " " + v.unit : ""}`;
};
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}


/* ── Motion helpers ────────────────────────────────────── */
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const tweens = new WeakMap();
// Count a number from one value to the next on the element's first text node.
function tween(el, from, to, dec) {
  const node = el.firstChild;
  if (!node || node.nodeType !== 3) return;
  cancelAnimationFrame(tweens.get(el));
  if (reduced() || !Number.isFinite(from) || from === to) { node.nodeValue = to.toFixed(dec); return; }
  const t0 = performance.now(), D = 600;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / D), e = 1 - (1 - k) ** 3;
    node.nodeValue = (from + (to - from) * e).toFixed(dec);
    if (k < 1) tweens.set(el, requestAnimationFrame(step));
  };
  tweens.set(el, requestAnimationFrame(step));
}
// Patch `a` to look like `b` while keeping its nodes, so CSS transitions run and numbers can glide.
function morph(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) { a.replaceWith(b); return; }
  if (a.nodeType === 3) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  if (a.nodeType !== 1) return;
  const numFrom = a.getAttribute("data-num"), numTo = b.getAttribute("data-num");
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  const ac = [...a.childNodes], bc = [...b.childNodes];
  if (ac.length !== bc.length) { a.replaceChildren(...bc); return; }
  ac.forEach((c, i) => {
    if (i === 0 && numTo != null && numFrom != null && c.nodeType === 3 && numFrom !== numTo) {
      tween(a, parseFloat(numFrom), parseFloat(numTo), +(b.getAttribute("data-dec") ?? 1));
    } else morph(c, bc[i]);
  });
}
function patch(container, html, svgNS = false) {
  const tpl = document.createElement(svgNS ? "div" : "template");
  tpl.innerHTML = svgNS ? `<svg xmlns="http://www.w3.org/2000/svg">${html}</svg>` : html;
  const fresh = svgNS ? tpl.firstChild : tpl.content;
  const kids = [...fresh.childNodes];
  const old = [...container.childNodes];
  if (old.length !== kids.length) { container.replaceChildren(...kids); return false; }
  old.forEach((c, i) => morph(c, kids[i]));
  return true;
}
const numAttr = (s, v = s.last_value) => (v == null || isBinary(s) ? "" : `data-num="${v.toFixed(decOf(s.type))}" data-dec="${decOf(s.type)}"`);

/* ── Floor plan ────────────────────────────────────────── */
function renderPlan() {
  const svg = $("#plan");
  const bad = alertingSensors();
  // Compact mode: on a narrow card the plan scales down, so its text is set larger in plan units.
  const C = svg.clientWidth < 480;
  svg.classList.toggle("compact", C);
  const byRoom = {};
  for (const s of state.sensors.values()) (byRoom[s.room] ??= []).push(s);
  let out = "";
  for (const [key, r] of Object.entries(ROOMS)) {
    const list = byRoom[key] ?? [];
    const temp = list.find((s) => s.type === "temperature");
    const hum = list.find((s) => s.type === "humidity");
    const motion = list.find((s) => s.type === "motion");
    const door = list.find((s) => s.type === "door");
    const co2 = list.find((s) => s.type === "co2");
    const pm = list.find((s) => s.type === "pm25");
    const leak = list.find((s) => s.type === "leak");
    const erv = list.find((s) => s.type === "ventilation");
    const primary = temp ?? hum ?? motion ?? door;
    const alerting = list.some((s) => bad.has(s.sensor_id));
    const selected = list.some((s) => s.sensor_id === state.selected);
    const x = r.x + (C ? 12 : 16);
    let body = "";
    if (key === "hallway") {
      const on = motion?.last_value === 1;
      body = `<text class="room-name" x="${x}" y="${r.y + (C ? 25 : 24)}">${r.label}</text>
        <text class="sub" x="${x}" y="${r.y + (C ? 48 : 44)}">${motion ? (motion.online ? (on ? "Someone is moving" : "No movement") : "Sensor offline") : "No sensor"}${erv?.last_value === 1 ? " · ERV running" : ""}</text>
        <circle class="motion-ring ${on ? "active" : ""}" cx="${r.x + r.w - 30}" cy="${r.y + r.h / 2}" r="8"/>
        <circle class="motion-dot ${on ? "active" : ""}" cx="${r.x + r.w - 30}" cy="${r.y + r.h / 2}" r="6"/>`;
    } else if (primary) {
      const v = fmtValue(primary);
      const off = !primary.online;
      const pBad = bad.has(primary.sensor_id);
      body = `<text class="room-name" x="${x}" y="${r.y + (C ? 30 : 26)}">${r.label}</text>
        <text class="reading ${pBad ? "bad" : ""} ${off ? "offline" : ""}" x="${x}" y="${r.y + (C ? 74 : 62)}" ${numAttr(primary)}>${v.text}<tspan class="unit" dx="3">${v.unit}</tspan></text>`;
      const extra = [];
      if (temp && hum) extra.push({ s: hum, t: `Humidity ${fmtValue(hum).text} %` });
      if (co2) extra.push({ s: co2, t: `CO₂ ${fmtValue(co2).text} ppm` });
      if (pm) extra.push({ s: pm, t: `PM2.5 ${fmtValue(pm).text} µg/m³` });
      if (leak) extra.push({ s: leak, t: leak.last_value === 1 ? "Leak detected" : "No leaks" });
      if (door && primary !== door) extra.push({ s: door, t: `${door.sensor_id === "door-back" ? "Back door" : "Door"} ${fmtValue(door).text.toLowerCase()}` });
      if (off) extra.unshift({ s: primary, t: `Offline · last ${ago(primary.last_ts)}` });
      else if (!C && !extra.length && primary.last_ts) extra.push({ s: { sensor_id: "" }, t: `Updated ${ago(primary.last_ts)}`, faint: true });
      extra.slice(0, 2).forEach((e, i) => {
        body += `<text class="sub ${bad.has(e.s.sensor_id) ? "bad" : ""} ${e.faint ? "fresh" : ""}" x="${x}" y="${r.y + (C ? 102 : 86) + i * (C ? 24 : 19)}">${esc(e.t)}</text>`;
      });
    } else {
      body = `<text class="room-name" x="${x}" y="${r.y + (C ? 30 : 26)}">${r.label}</text>`;
    }
    out += `<g class="room ${alerting ? "alerting" : ""} ${selected ? "selected" : ""}" data-room="${key}" data-sensor="${primary?.sensor_id ?? ""}" tabindex="${primary ? 0 : -1}" role="button" aria-label="${r.label}${primary ? ": " + fmtValue(primary).text : ""}">
      <rect class="floor" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="14"/>
      <rect class="edge" x="${r.x + 0.75}" y="${r.y + 0.75}" width="${r.w - 1.5}" height="${r.h - 1.5}" rx="13.5"/>
      ${body}</g>`;
  }
  for (const [id, d] of Object.entries(DOORS)) {
    const s = state.sensors.get(id);
    if (!s) continue;
    const open = s.last_value === 1;
    const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
    const [hx, hy] = d.hinge;
    const swing = `M ${d.x2} ${d.y2} A ${len} ${len} 0 0 ${d.swing > 0 ? 1 : 0} ${hx} ${hy + d.swing * -len}`;
    const angle = open ? d.swing * 72 : 0;
    out += `<path class="door-swing ${open ? "open" : ""}" d="${swing}"/>
      <line class="door-frame" x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}"/>
      <line class="door ${open ? "open" : ""} ${bad.has(id) ? "alerting" : ""}" x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}" style="transform-origin: ${hx}px ${hy}px; transform: rotate(${angle}deg)"><title>${sensorName(s)}: ${fmtValue(s).text}</title></line>`;
  }
  patch(svg, out, true);
  svg.querySelectorAll(".room[data-sensor]").forEach((g) => {
    if (!g.dataset.sensor) return;
    g.onclick = () => select(g.dataset.sensor);
    g.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), select(g.dataset.sensor));
  });
}

/* ── Summary line ──────────────────────────────────────── */
function renderSummary() {
  const all = [...state.sensors.values()];
  if (!all.length) return;
  const online = all.filter((s) => s.online).length;
  const alerts = [...state.active.values()].sort((a, b) => (a.severity === "critical" ? -1 : 1) - (b.severity === "critical" ? -1 : 1));
  const reporting = online === all.length ? `All ${all.length} sensors reporting` : `${online} of ${all.length} sensors reporting`;
  let text;
  if (!alerts.length) text = `<strong>${reporting}</strong> and every reading is in range.`;
  else {
    const a = alerts[0];
    const s = state.sensors.get(a.sensor_id);
    const more = alerts.length > 1 ? ` and ${alerts.length - 1} more` : "";
    text = `<strong>${reporting}.</strong> <span class="bad">${alerts.length} alert${alerts.length > 1 ? "s" : ""}</span>: ${esc(s ? sensorName(s) : a.sensor_id)} ${esc(alertText(a))} since ${time(a.opened_at)}${more}.`;
  }
  const sum = $("#summary");
  const shape = `${online}/${all.length}/${alerts.length}`;
  if (sum.innerHTML !== text) {
    sum.innerHTML = text;
    sum.dataset.shape = shape;
  }
  $("#scope").textContent = `${all.length} sensors in ${new Set(all.map((s) => s.room)).size} rooms`;
  $("#online-count").textContent = `${online} of ${all.length} online`;
}

/* ── Alerts ────────────────────────────────────────────── */
// The cleared list fills the card's spare height and stops at the last row that fits whole.
function fitCleared() {
  const ul = $("#alerts");
  if (getComputedStyle(ul).overflowY !== "auto") {  // stacked layouts: keep three
    ul.querySelectorAll(".alert.cleared").forEach((li, i) => i >= 3 && li.remove());
  } else {
    let rows = [...ul.querySelectorAll(".alert.cleared")];
    while (rows.length && ul.scrollHeight > ul.clientHeight + 1) rows.pop().remove();
  }
  const head = ul.querySelector(".sub-head");
  if (head && !ul.querySelector(".alert.cleared")) head.remove();
}

function renderAlerts() {
  const list = [...state.active.values()].sort((a, b) => b.opened_at - a.opened_at);
  const badge = $("#alert-count");
  badge.textContent = list.length;
  $("#alert-count").classList.toggle("hot", list.length > 0);
  if (!list.length) {
    const done = state.log.filter((a) => a.resolved_at != null).slice(0, 8);
    const nowS = Date.now() / 1000;
    $("#alerts").innerHTML = `<li class="all-clear"><strong>All clear</strong>Every sensor is reporting and every reading is in range.</li>` +
      (done.length ? `<li class="sub-head">Cleared recently</li>` + done.map((a) => {
        const s = state.sensors.get(a.sensor_id);
        return `<li class="alert cleared"><span class="who">${esc(s ? sensorName(s) : a.sensor_id)}</span><span class="when">${dur(nowS - a.resolved_at)} ago</span><span class="what">${esc(alertText(a, false))}, lasted ${dur(a.resolved_at - a.opened_at)}</span></li>`;
      }).join("") : "");
    fitCleared();
    return;
  }
  const now = Date.now() / 1000;
  const html = list.slice(0, 6).map((a) => {
    const s = state.sensors.get(a.sensor_id);
    return `<li class="alert">
      <span class="who">${esc(s ? sensorName(s) : a.sensor_id)}</span><span class="when">for ${dur(now - a.opened_at)}</span>
      <span class="what">${esc(alertText(a))}</span>
      <span class="pill ${a.severity}">${a.severity === "critical" ? "Critical" : "Warning"}</span>
    </li>`;
  }).join("");
  // Under the open alerts, the ones that cleared most recently, so the card shows what just happened.
  const cleared = state.log.filter((a) => a.resolved_at != null).slice(0, 8);
  const recent = cleared.length ? `<li class="sub-head">Cleared recently</li>` + cleared.map((a) => {
    const s = state.sensors.get(a.sensor_id);
    return `<li class="alert cleared"><span class="who">${esc(s ? sensorName(s) : a.sensor_id)}</span><span class="when">${dur(now - a.resolved_at)} ago</span>
      <span class="what">${esc(alertText(a, false))}, lasted ${dur(a.resolved_at - a.opened_at)}</span></li>`;
  }).join("") : "";
  patch($("#alerts"), html + recent);
  fitCleared();
}

/* ── Sensor list ───────────────────────────────────────── */
function renderSensors() {
  const bad = alertingSensors();
  const rows = [...state.sensors.values()].sort((a, b) => roomOf(a).localeCompare(roomOf(b)) || a.type.localeCompare(b.type));
  patch($("#sensors"), rows.map((s) => {
    const v = fmtValue(s);
    const dot = !s.online ? "off" : bad.has(s.sensor_id) ? "bad" : "";
    return `<li><button type="button" data-id="${s.sensor_id}" aria-current="${s.sensor_id === state.selected}">
      <span class="dot ${dot}" aria-hidden="true"></span>
      <span class="name">${esc(roomOf(s))}<small>${esc(s.type === "door" ? sensorName(s).toLowerCase() : TYPE_LABEL[s.type])}</small></span>
      <span class="val ${bad.has(s.sensor_id) ? "bad" : ""}" ${s.online ? numAttr(s) : ""}>${s.online ? v.text : "Offline"}${s.online && v.unit ? `<span class="unit">${v.unit}</span>` : ""}</span>
    </button></li>`;
  }).join(""));
  $("#sensors").querySelectorAll("button").forEach((b) => (b.onclick = () => select(b.dataset.id)));
}

/* ── Alert log and rules ───────────────────────────────── */
function renderLog() {
  const rows = state.log.slice(0, 8);
  if (!rows.length) {
    $("#log").innerHTML = `<tr><td colspan="5" class="log-empty">No alerts yet. They appear here when a reading crosses a rule.</td></tr>`;
    return;
  }
  const now = Date.now() / 1000;
  $("#log").innerHTML = rows.map((a) => {
    const s = state.sensors.get(a.sensor_id);
    const lasted = a.resolved_at == null ? `<span class="open">Open · ${dur(now - a.opened_at)}</span>` : dur(a.resolved_at - a.opened_at);
    return `<tr><td class="time">${time(a.opened_at, true)}</td><td>${esc(s ? sensorName(s) : a.sensor_id)}</td><td>${esc(alertText(a, false))}</td><td class="num">${readingText(a)}</td><td class="num">${lasted}</td></tr>`;
  }).join("");
}

function renderRules() {
  const pretty = (n) => n.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
    .replace("Co2", "CO₂").replace("Pm25", "PM2.5").replace("Voc", "VOC").replace("Tds", "TDS");
  const unitFor = (t) => (UNIT[t] ? " " + UNIT[t] : "");
  const held = (sec) => (!sec ? "" : sec >= 120 ? ` for ${sec / 60} min` : ` for ${sec} s`);
  const word = { ">": "above", ">=": "at or above", "<": "below", "<=": "at or below" };
  const rows = state.rules.rules.map((r) => {
    let opens, clears;
    if (r.sensor_type === "door") { opens = `Open${held(r.for_seconds)}`; clears = "Closed"; }
    else if (r.sensor_type === "leak") { opens = `Wet${held(r.for_seconds)}`; clears = "Dry"; }
    else {
      opens = `${word[r.op] ?? r.op} ${r.threshold}${unitFor(r.sensor_type)}${held(r.for_seconds)}`;
      const back = r.clear_at ?? r.threshold;
      clears = `${r.op.startsWith(">") ? "below" : "above"} ${back}${unitFor(r.sensor_type)}`;
      opens = opens.charAt(0).toUpperCase() + opens.slice(1);
      clears = clears.charAt(0).toUpperCase() + clears.slice(1);
    }
    const then = r.activates?.length ? "Ventilation on" : `<span class="r-grey">Alert only</span>`;
    const sev = `<span class="pill ${r.severity}">${r.severity === "critical" ? "Critical" : "Warning"}</span>`;
    return `<tr><td class="r-name">${pretty(r.name)}</td><td class="r-grey">${esc(TYPE_LABEL[r.sensor_type] ?? r.sensor_type)}</td><td>${opens}</td><td class="r-grey">${clears}</td><td>${then}</td><td>${sev}</td></tr>`;
  });
  rows.push(`<tr><td class="r-name">Sensor offline</td><td class="r-grey">any</td><td>No reading for ${state.rules.stale_after_seconds} s</td><td class="r-grey">Next reading</td><td><span class="r-grey">Alert only</span></td><td><span class="pill warning">Warning</span></td></tr>`);
  $("#rules").innerHTML = rows.join("");
}

/* ── Air and water ─────────────────────────────────────── */
// Bands for the tiles. Limits match rules.yaml; "good" levels follow WHO / common indoor-air guidance.
const WELLNESS = [
  { id: "co2-living", label: "CO₂, living room", max: 2000, band: (v) => (v < 800 ? 0 : v <= 1000 ? 1 : 2), ok: "Fresh" },
  { id: "co2-bedroom", label: "CO₂, bedroom", max: 2000, band: (v) => (v < 800 ? 0 : v <= 1000 ? 1 : 2), ok: "Fresh" },
  { id: "pm25-kitchen", label: "PM2.5, kitchen", max: 100, band: (v) => (v <= 15 ? 0 : v <= 35 ? 1 : 2), ok: "Clean" },
  { id: "voc-living", label: "VOC, living room", max: 1200, band: (v) => (v < 300 ? 0 : v <= 500 ? 1 : 2), ok: "Low" },
  { id: "tds-kitchen", label: "Water TDS, kitchen tap", max: 500, band: (v) => (v < 30 || v > 300 ? 2 : v > 250 ? 1 : 0), ok: "Filter working" },
  { id: "leak-bathroom", label: "Leak, bathroom sink", band: (v) => (v ? 2 : 0), ok: "Dry" },
];
const BAND = ["good", "fair", "poor"];

function ventilationText() {
  const erv = state.sensors.get("erv-main");
  const auto = state.automations["erv-main"];
  const on = erv ? erv.last_value === 1 : auto?.state === "ON";
  if (!on) return { on, text: "Ventilation off" };
  const why = (auto?.because ?? []).map((k) => state.sensors.get(k.split(":")[0])).filter(Boolean);
  if (!why.length) return { on, text: "Ventilation on" };
  return { on, text: `Ventilation on: ${why.map((s) => `${TYPE_LABEL[s.type]} in the ${roomOf(s).toLowerCase()}`).join(", ")}` };
}

function renderWellness() {
  const tiles = WELLNESS.map((w) => {
    const s = state.sensors.get(w.id);
    if (!s) return `<button type="button" class="tile" disabled><span class="t-label">${w.label}</span><span class="t-value offline">–</span><span class="t-note">No reading yet</span></button>`;
    const v = fmtValue(s);
    const off = !s.online;
    const b = s.last_value == null ? 0 : w.band(s.last_value);
    const thr = thresholdFor(s);
    const rule = state.rules.rules.find((r) => r.sensor_type === s.type && r.op === ">");
    let note = w.ok;
    if (s.type === "leak") note = s.last_value ? "Water under the sink" : "No water detected";
    else if (b === 2) note = s.type === "tds" && s.last_value < 30 ? "Very low" : `Over the ${rule?.threshold ?? ""} ${UNIT[s.type]} limit`;
    else if (b === 1) note = s.type === "tds" ? "Filter wearing" : "Getting stale";
    const bar = w.max && s.last_value != null
      ? `<span class="t-bar"><span class="t-fill ${BAND[b]}" style="width: ${Math.min(100, (s.last_value / w.max) * 100).toFixed(1)}%"></span>${thr != null ? `<span class="t-limit" style="left: ${((thr / w.max) * 100).toFixed(1)}%"></span>` : ""}</span>`
      : `<span class="t-bar"></span>`;
    return `<button type="button" class="tile" data-id="${w.id}" aria-current="${w.id === state.selected}">
      <span class="t-label">${w.label}</span>
      <span class="t-value ${off ? "offline" : b === 2 ? "poor" : ""}" ${off ? "" : numAttr(s)}>${off ? "Offline" : v.text}${!off && v.unit ? `<span class="unit">${v.unit}</span>` : ""}</span>
      <span class="t-note ${off ? "" : BAND[b]}">${off ? `Last seen ${ago(s.last_ts)}` : note}</span>
      ${bar}
    </button>`;
  }).join("");
  patch($("#tiles"), tiles);
  $("#tiles").querySelectorAll(".tile[data-id]").forEach((t) => (t.onclick = () => select(t.dataset.id)));
  const vt = ventilationText();
  const erv = $("#erv");
  erv.textContent = vt.text;
  erv.classList.toggle("on", vt.on);
}

/* ── Circadian light ──────────────────────────────────── */
// Colour of a black-body light at `k` kelvin (Tanner Helland's approximation).
function kelvinRGB(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * (t - 60) ** -0.1332047592; g = 288.1221695283 * (t - 60) ** -0.0755148492; }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}
const phase = (h) => (h < 5.5 ? "Night light" : h < 8 ? "Sunrise" : h < 12 ? "Morning" : h < 15 ? "Midday" : h < 18 ? "Afternoon" : h < 20 ? "Evening" : h < 23 ? "Winding down" : "Night light");

function renderLight() {
  const k = state.sensors.get("light-living-kelvin"), b = state.sensors.get("light-living-level");
  const c = state.circadian;
  const kelvin = k?.last_value ?? c?.target.kelvin, level = b?.last_value ?? c?.target.brightness;
  if (kelvin == null) return;
  const rgb = kelvinRGB(kelvin);
  const bulb = $("#bulb");
  bulb.style.setProperty("--bulb", rgb);
  $("#light-k").innerHTML = `${Math.round(kelvin)}<span class="unit">K</span>`;
  $("#light-b").textContent = `${Math.round(level)} % brightness`;
  if (!c) return;
  $("#light-sub").textContent = `${phase(c.hour)}, ${c.timezone.replace("_", " ")} time`;
  const svg = $("#daystrip");
  const W = svg.clientWidth || 300, H = Math.max(112, svg.clientHeight || 112), T = 18, B = 20, cols = c.schedule.slice(0, -1);
  const cw = W / cols.length, Y = (pct) => T + (1 - pct / 100) * (H - T - B);
  const bars = cols.map((p, i) => {
    const y = Y(Math.max(2, p.brightness));
    return `<rect x="${(i * cw + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${(cw - 1).toFixed(1)}" height="${(H - B - y).toFixed(1)}" fill="${kelvinRGB(p.kelvin)}"><title>${String(Math.floor(p.hour)).padStart(2, "0")}:${p.hour % 1 ? "30" : "00"} · ${p.kelvin} K · ${p.brightness} %</title></rect>`;
  }).join("");
  const nx = (c.hour / 24) * W;
  const labels = [0, 6, 12, 18, 24].map((h) => `<text class="tick" x="${(h / 24) * W}" y="${H - 4}" text-anchor="${h === 0 ? "start" : h === 24 ? "end" : "middle"}">${String(h % 24).padStart(2, "0")}:00</text>`).join("");
  const anchor = nx > W - 40 ? "end" : nx < 40 ? "start" : "middle";
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `${bars}<line class="base" x1="0" x2="${W}" y1="${H - B + 0.5}" y2="${H - B + 0.5}"/>
    <line class="now-line" x1="${nx}" x2="${nx}" y1="${T - 2}" y2="${H - B}"/>
    <text class="now-label" x="${nx}" y="${T - 6}" text-anchor="${anchor}">Now</text>
    ${labels}`;
}

/* ── History chart (SVG, drawn from the points) ────────── */
function ticks(min, max, count = 4) {
  if (max === min) { max += 1; min -= 1; }
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  if (hi <= max) hi += step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}

function thresholdFor(s) {
  const rule = state.rules.rules.find((r) => r.sensor_type === s.type && r.op === ">");
  return rule && !isBinary(s) ? rule.threshold : null;
}

function renderChart() {
  const el = $("#chart");
  const s = state.sensors.get(state.selected);
  if (!s) return;
  const pts = state.points;
  const v = fmtValue(s);
  $("#chart-h").textContent = `History · ${sensorName(s)}`;
  $("#chart-sub").textContent = `Last ${state.minutes >= 60 ? state.minutes / 60 + " h" : state.minutes + " min"}${state.minutes > 15 ? ", averaged" : ""}`;
  animateLead(s, v);
  const thr = thresholdFor(s);
  const note = $("#lead-note");
  const hyst = state.rules.rules.find((r) => r.sensor_type === s.type && r.op === ">" && r.clear_at != null);
  if (bad(s)) {
    if (thr != null && s.last_value <= thr && hyst) note.textContent = `Alert open until it drops below ${hyst.clear_at} ${v.unit}`;
    else note.textContent = thr != null ? `Above the ${thr} ${v.unit} limit` : "Alert open";
    note.className = "lead-note bad";
  }
  else if (pts.length && !isBinary(s)) {
    const vals = pts.map((p) => p.value);
    const d = decOf(s.type);
    note.textContent = `Range ${Math.min(...vals).toFixed(d)}–${Math.max(...vals).toFixed(d)} ${v.unit} in this window`;
    note.className = "lead-note";
  } else note.textContent = "";

  if (pts.length < 2) { el.innerHTML = `<div class="chart-empty">Collecting readings…</div>`; return; }
  const W = el.clientWidth, H = el.clientHeight, L = 40, R = 8, T = 10, B = 24;
  const xs = pts.map((p) => p.ts), x0 = xs[0], x1 = xs[xs.length - 1];
  let yt;
  if (isBinary(s)) yt = [0, 1];
  else {
    const vals = pts.map((p) => p.value);
    const lo = Math.min(...vals, thr ?? Infinity), hi = Math.max(...vals, thr ?? -Infinity);
    yt = ticks(lo, hi, 4);
  }
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const X = (t) => L + ((t - x0) / Math.max(1, x1 - x0)) * (W - L - R);
  const Y = (val) => T + (1 - (val - y0) / (y1 - y0 || 1)) * (H - T - B);
  let d = "";
  pts.forEach((p, i) => {
    if (isBinary(s) && i) d += ` H ${X(p.ts).toFixed(1)} V ${Y(p.value).toFixed(1)}`;
    else d += `${i ? " L" : "M"} ${X(p.ts).toFixed(1)} ${Y(p.value).toFixed(1)}`;
  });
  const grid = yt.map((t) => `<line class="gridline" x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/>
    <text class="tick" x="${L - 8}" y="${Y(t) + 4}" text-anchor="end">${isBinary(s) ? BINARY[s.type][t ? 0 : 1] : t}</text>`).join("");
  // X labels: one step, on round minutes.
  const span = x1 - x0, stepS = [60, 120, 300, 600, 900, 1800, 3600, 7200].find((st) => span / st <= 6) ?? 7200;
  let xl = "";
  for (let t = Math.ceil(x0 / stepS) * stepS; t <= x1; t += stepS) {
    xl += `<text class="tick" x="${X(t)}" y="${H - 6}" text-anchor="middle">${time(t)}</text>`;
  }
  const thrLine = thr != null && thr <= y1 ? `<line class="threshold" x1="${L}" x2="${W - R}" y1="${Y(thr)}" y2="${Y(thr)}"/><text class="threshold-label" x="${W - R}" y="${Y(thr) - 6}" text-anchor="end">Alert above ${thr} ${v.unit}</text>` : "";
  const area = isBinary(s) ? `<path class="area" d="${d} V ${Y(y0)} H ${X(x0)} Z"/>` : "";
  const drawIn = renderChart.drawIn && !reduced();
  renderChart.drawIn = false;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sensorName(s))} over the last ${state.minutes} minutes">
    ${grid}${xl}${thrLine}${area}<path class="line" d="${d}"/>
    <circle class="live-ring" cx="${X(x1)}" cy="${Y(pts[pts.length - 1].value)}" r="5" style="animation-delay: -${((performance.now() % 1800) / 1000).toFixed(2)}s"/>
    <circle class="live-head" cx="${X(x1)}" cy="${Y(pts[pts.length - 1].value)}" r="4"/>
    <line class="cursor" y1="${T}" y2="${H - B}" hidden/><circle class="dot" r="4" hidden/></svg>`;
  const svg = el.querySelector("svg"), cur = svg.querySelector(".cursor"), dot = svg.querySelector(".dot"), tip = $("#tooltip");
  if (drawIn) {
    const line = svg.querySelector(".line"), len = line.getTotalLength();
    line.style.strokeDasharray = `${len}`;
    line.style.strokeDashoffset = `${len}`;
    line.getBoundingClientRect();
    line.style.transition = "stroke-dashoffset 0.9s cubic-bezier(0.22, 1, 0.36, 1)";
    line.style.strokeDashoffset = "0";
    svg.classList.add("fade-in");
  }
  svg.onpointermove = (e) => {
    const rect = svg.getBoundingClientRect();
    const t = x0 + ((e.clientX - rect.left - L) / (W - L - R)) * (x1 - x0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p;
    const px = X(best.ts), py = Y(best.value);
    cur.setAttribute("x1", px); cur.setAttribute("x2", px); cur.hidden = false;
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.hidden = false;
    const fv = fmtValue(s, best.value);
    tip.textContent = `${time(best.ts, true)}  ${fv.text}${fv.unit ? " " + fv.unit : ""}`;
    tip.hidden = false;
    tip.style.left = `${rect.left + (px / W) * rect.width + 12}px`;
    tip.style.top = `${rect.top + (py / H) * rect.height - 30}px`;
  };
  svg.onpointerleave = () => { cur.hidden = true; dot.hidden = true; tip.hidden = true; };
}
const bad = (s) => alertingSensors().has(s.sensor_id);

let leadShown = null;
function animateLead(s, v) {
  const el = $("#lead-value");
  const target = s.last_value;
  if (isBinary(s) || target == null || leadShown == null || leadShown.id !== s.sensor_id) {
    el.innerHTML = `${v.text}${v.unit ? `<span class="unit">${v.unit}</span>` : ""}`;
    leadShown = { id: s.sensor_id, value: target };
    return;
  }
  const from = leadShown.value, t0 = performance.now(), token = (animateLead.token = (animateLead.token ?? 0) + 1);
  leadShown = { id: s.sensor_id, value: target };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === target) {
    el.innerHTML = `${v.text}<span class="unit">${v.unit}</span>`;
    return;
  }
  const step = (now) => {
    if (token !== animateLead.token) return; // a newer reading took over
    const k = Math.min(1, (now - t0) / 450), e = 1 - (1 - k) ** 3;
    el.innerHTML = `${(from + (target - from) * e).toFixed(decOf(s.type))}<span class="unit">${v.unit}</span>`;
    if (k < 1 && leadShown.id === s.sensor_id) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function loadHistory() {
  if (!state.selected) return;
  renderChart.drawIn = true;
  state.points = await getJSON(`/api/sensors/${state.selected}/history?minutes=${state.minutes}`).catch(() => []);
  renderChart();
}

function select(id) {
  state.selected = id;
  renderPlan();
  renderSensors();
  loadHistory();
}

/* ── Live updates ──────────────────────────────────────── */
function pulseReading(r) {
  if (reduced()) return;
  const val = document.querySelector(`#sensors button[data-id="${r.sensor_id}"] .val`);
  if (val) val.animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
}

function onReading(r) {
  const prev = state.sensors.get(r.sensor_id) ?? {};
  state.sensors.set(r.sensor_id, { ...prev, ...r, last_value: r.value, last_ts: r.ts, online: true });
  state.messages.push(Date.now());
  requestAnimationFrame(() => pulseReading(r));
  if (r.sensor_id === state.selected) {
    state.points.push({ ts: r.ts, value: r.value });
    const cutoff = Date.now() / 1000 - state.minutes * 60;
    while (state.points.length && state.points[0].ts < cutoff) state.points.shift();
  }
  scheduleRender();
}

function onAlert(event, a) {
  if (event === "opened") state.active.set(a.key, a);
  else state.active.delete(a.key);
  const i = state.log.findIndex((x) => x.id === a.id);
  if (i >= 0) state.log[i] = a; else state.log.unshift(a);
  scheduleRender();
}

let pending = false;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderPlan(); renderSummary(); renderAlerts(); renderSensors(); renderLog(); renderChart(); renderWellness(); renderLight();
  });
}

function setStatus(kind, text) {
  $("#status").className = `status ${kind}`;
  $("#status-text").textContent = text;
  document.querySelector(".pipeline").classList.toggle("idle", kind !== "live");
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => setStatus("live", "Live");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.kind === "reading") onReading(m.data);
    else if (m.kind === "alert") onAlert(m.event, m.data);
    else if (m.kind === "automation") { state.automations = m.data; scheduleRender(); }
  };
  ws.onclose = () => {
    setStatus("down", "Reconnecting");
    setTimeout(async () => { await loadAll().catch(() => {}); connect(); }, 2000);
  };
}

async function loadAll() {
  const [sensors, active, log, rules, automations, circadian] = await Promise.all([
    getJSON("/api/sensors"), getJSON("/api/alerts?active=true"), getJSON("/api/alerts?limit=8"), getJSON("/api/rules"),
    getJSON("/api/automations"), getJSON("/api/circadian"),
  ]);
  state.automations = automations;
  state.circadian = circadian;
  state.sensors = new Map(sensors.map((s) => [s.sensor_id, s]));
  state.active = new Map(active.map((a) => [a.key, a]));
  state.log = log;
  state.rules = rules;
  if (!state.selected && sensors.length) {
    const firstBad = active[0]?.sensor_id;
    state.selected = firstBad ?? sensors.find((s) => s.sensor_id === "temp-living")?.sensor_id ?? sensors[0].sensor_id;
  }
  renderRules();
  scheduleRender();
  await loadHistory();
}

// Once a second: the rate, the freshness stamp and the "x s ago" labels.
setInterval(() => {
  const cutoff = Date.now() - 60000;
  while (state.messages.length && state.messages[0] < cutoff) state.messages.shift();
  $("#rate").textContent = `${state.messages.length} readings/min`;
  const last = Math.max(0, ...[...state.sensors.values()].map((s) => s.last_ts ?? 0));
  $("#stamp").textContent = last ? `Last reading ${time(last, true)}` : "";
}, 1000);
// Every minute: where we are in the circadian day.
setInterval(async () => {
  state.circadian = await getJSON("/api/circadian").catch(() => state.circadian);
  scheduleRender();
}, 60000);
// Every 5 s: online flags from the server (offline detection lives there).
setInterval(async () => {
  const sensors = await getJSON("/api/sensors").catch(() => null);
  if (!sensors) return;
  sensors.forEach((s) => state.sensors.set(s.sensor_id, { ...state.sensors.get(s.sensor_id), ...s }));
  scheduleRender();
}, 5000);

document.querySelectorAll(".segmented button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".segmented button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    state.minutes = Number(b.dataset.min);
    loadHistory();
  };
});
// The bar gets a rule once content scrolls under it.
addEventListener("scroll", () => document.querySelector(".topbar").classList.toggle("scrolled", scrollY > 4), { passive: true });
let resizeT;
addEventListener("resize", () => renderPlan());
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { renderChart(); renderLight(); }, 120); });

loadAll().then(connect).catch(() => { setStatus("down", "Backend unreachable"); setTimeout(() => location.reload(), 5000); });
