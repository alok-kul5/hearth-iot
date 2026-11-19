// Live dashboard: loads current state over REST, then follows the WebSocket feed.

const state = {
  sensors: new Map(),   // sensor_id -> sensor row
  active: new Map(),    // alert key -> alert row
  selected: null,
  minutes: 15,
  chart: null,
};

const LABELS = {
  temperature: "Temperature",
  humidity: "Humidity",
  motion: "Motion",
  door: "Door",
};

const $ = (sel) => document.querySelector(sel);
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ago = (ts) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

function displayValue(s) {
  if (s.last_value == null) return "–";
  if (s.type === "door") return s.last_value ? "Open" : "Closed";
  if (s.type === "motion") return s.last_value ? "Motion" : "Clear";
  return `${s.last_value.toFixed(1)}<small>${s.unit}</small>`;
}

function renderSensors() {
  const grid = $("#sensors");
  const alerting = new Set([...state.active.values()].map((a) => a.sensor_id));
  grid.replaceChildren(
    ...[...state.sensors.values()].map((s) => {
      const el = document.createElement("button");
      el.className = "card";
      el.dataset.id = s.sensor_id;
      el.classList.toggle("selected", s.sensor_id === state.selected);
      el.classList.toggle("alerting", alerting.has(s.sensor_id));
      el.classList.toggle("offline", s.online === false);
      el.innerHTML = `
        <span class="room">${s.room.replace("_", " ")}</span>
        <span class="name">${LABELS[s.type] ?? s.type} · ${s.sensor_id}</span>
        <span class="value">${displayValue(s)}</span>
        <span class="meta">${s.online === false ? "offline" : s.last_ts ? ago(s.last_ts) : ""}</span>`;
      el.onclick = () => select(s.sensor_id);
      return el;
    }),
  );
}

function renderAlerts() {
  const list = $("#alerts");
  const items = [...state.active.values()].sort((a, b) => b.opened_at - a.opened_at);
  $("#alert-count").textContent = items.length;
  $("#alert-count").classList.toggle("hot", items.length > 0);
  if (!items.length) {
    list.innerHTML = `<li class="empty">No active alerts</li>`;
    return;
  }
  list.replaceChildren(
    ...items.map((a) => {
      const li = document.createElement("li");
      li.className = `alert ${a.severity}`;
      li.innerHTML = `<div><span class="who">${a.sensor_id}</span> · ${a.message}</div>
        <span class="when">since ${fmtTime(a.opened_at)}</span>`;
      return li;
    }),
  );
}

function addLogRow(a, prepend = true) {
  const body = $("#log");
  let row = body.querySelector(`tr[data-id="${a.id}"]`);
  if (!row) {
    row = document.createElement("tr");
    row.dataset.id = a.id;
    prepend ? body.prepend(row) : body.append(row);
  }
  const open = a.resolved_at == null;
  row.innerHTML = `<td>${fmtTime(a.opened_at)}</td><td>${a.sensor_id}</td><td>${a.message}</td>
    <td><span class="pill ${open ? "open" : ""}">${open ? "open" : "resolved " + fmtTime(a.resolved_at)}</span></td>`;
  while (body.children.length > 40) body.lastChild.remove();
}

async function loadChart() {
  if (!state.selected || !window.Chart) return;
  const s = state.sensors.get(state.selected);
  $("#chart-title").textContent = `${s.sensor_id} (${s.room.replace("_", " ")})`;
  const res = await fetch(`/api/sensors/${state.selected}/history?minutes=${state.minutes}`);
  const points = await res.json();
  const data = points.map((p) => ({ x: p.ts * 1000, y: p.value }));
  const binary = s.type === "door" || s.type === "motion";
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const muted = css.getPropertyValue("--muted").trim();
  const line = css.getPropertyValue("--line").trim();

  if (state.chart) state.chart.destroy();
  state.chart = new Chart($("#chart"), {
    type: "line",
    data: {
      datasets: [{
        data, borderColor: accent, backgroundColor: accent + "22", fill: "start",
        borderWidth: 2, pointRadius: 0, tension: binary ? 0 : 0.25, stepped: binary,
      }],
    },
    options: {
      animation: false, maintainAspectRatio: false, parsing: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          type: "linear", ticks: { color: muted, maxTicksLimit: 6, callback: (v) => fmtTime(v / 1000) },
          grid: { color: line },
        },
        y: {
          ticks: { color: muted, callback: binary ? (v) => (v === 1 ? (s.type === "door" ? "open" : "motion") : v === 0 ? "—" : "") : (v) => +v.toFixed(2) },
          grid: { color: line }, ...(binary ? { min: 0, max: 1 } : {}),
          title: { display: !binary, text: s.unit, color: muted },
        },
      },
    },
  });
}

function select(id) {
  state.selected = id;
  renderSensors();
  loadChart();
}

function onReading(r) {
  const prev = state.sensors.get(r.sensor_id) ?? {};
  state.sensors.set(r.sensor_id, { ...prev, ...r, last_value: r.value, last_ts: r.ts, online: true });
  renderSensors();
  const card = document.querySelector(`.card[data-id="${r.sensor_id}"]`);
  card?.classList.add("flash");
  if (r.sensor_id === state.selected && state.chart) {
    const ds = state.chart.data.datasets[0].data;
    ds.push({ x: r.ts * 1000, y: r.value });
    const cutoff = Date.now() - state.minutes * 60 * 1000;
    while (ds.length && ds[0].x < cutoff) ds.shift();
    state.chart.update("none");
  }
}

function onAlert(event, a) {
  if (event === "opened") state.active.set(a.key, a);
  else state.active.delete(a.key);
  renderAlerts();
  renderSensors();
  addLogRow(a);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $("#status").classList.add("live");
    $("#status-text").textContent = "Live";
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.kind === "reading") onReading(msg.data);
    else if (msg.kind === "alert") onAlert(msg.event, msg.data);
  };
  ws.onclose = () => {
    $("#status").classList.remove("live");
    $("#status-text").textContent = "Reconnecting…";
    setTimeout(async () => { await loadInitial(); connect(); }, 2000);
  };
}

async function loadInitial() {
  const [sensors, active, log] = await Promise.all([
    fetch("/api/sensors").then((r) => r.json()),
    fetch("/api/alerts?active=true").then((r) => r.json()),
    fetch("/api/alerts?limit=40").then((r) => r.json()),
  ]);
  state.sensors = new Map(sensors.map((s) => [s.sensor_id, s]));
  state.active = new Map(active.map((a) => [a.key, a]));
  if (!state.selected && sensors.length) state.selected = sensors.find((s) => s.type === "temperature")?.sensor_id ?? sensors[0].sensor_id;
  $("#log").replaceChildren();
  log.forEach((a) => addLogRow(a, false));
  renderSensors();
  renderAlerts();
  loadChart();
}

document.querySelectorAll(".ranges button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".ranges button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    state.minutes = Number(b.dataset.min);
    loadChart();
  };
});

// Refresh the "Ns ago" / offline labels even when nothing arrives.
setInterval(async () => {
  const sensors = await fetch("/api/sensors").then((r) => r.json()).catch(() => null);
  if (!sensors) return;
  sensors.forEach((s) => state.sensors.set(s.sensor_id, { ...state.sensors.get(s.sensor_id), ...s }));
  renderSensors();
}, 5000);

loadInitial().then(connect);
