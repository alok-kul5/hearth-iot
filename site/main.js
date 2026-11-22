// Hearth landing page: the day slider, the stage crossfade, the dashboard tabs and entrances.
document.documentElement.classList.add("js");

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

// The same circadian keyframes the backend uses (backend/app/circadian.py): hour, kelvin, brightness %.
const KEYFRAMES = [
  [0, 1800, 3], [5.5, 1800, 3], [6.5, 2400, 30], [8, 4000, 80], [12, 5500, 100],
  [15, 5000, 100], [18, 3500, 85], [20, 2700, 60], [22, 2200, 25], [23, 1800, 5], [24, 1800, 3],
];

function setpoint(hour) {
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const [h0, k0, b0] = KEYFRAMES[i], [h1, k1, b1] = KEYFRAMES[i + 1];
    if (hour >= h0 && hour <= h1) {
      const f = (hour - h0) / (h1 - h0);
      return [Math.round((k0 + (k1 - k0) * f) / 50) * 50, Math.round(b0 + (b1 - b0) * f)];
    }
  }
  return [1800, 3];
}

// Approximate colour of a light source at a given colour temperature.
function kelvinRGB(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.7 * (t - 60) ** -0.1332;
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -0.0755;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}

const day = document.getElementById("day");
const clock = document.getElementById("clock");
const line = document.getElementById("lightline");
const wash = document.querySelector(".stage__wash");
const pics = document.querySelector(".stage__pics");
const fmt = new Intl.NumberFormat("en-GB");

function paint(minutes) {
  const hour = minutes / 60;
  const [k, b] = setpoint(hour);
  const [r, g, bl] = kelvinRGB(k);
  const hh = String(Math.floor(hour)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  clock.textContent = `${hh}:${mm}`;
  line.textContent = b <= 5 ? `Night light, ${fmt.format(k)} K at ${b}%` : `Lights at ${fmt.format(k)} K, ${b}%`;
  // Daylight warms the photograph a little; after dark the room cools to a dim blue-slate.
  const night = b <= 30;
  wash.style.backgroundColor = night ? "#3d5468" : `rgb(${r} ${g} ${bl})`;
  wash.style.opacity = night ? (0.12 + (30 - b) / 300).toFixed(2) : (0.1 + (1 - b / 100) * 0.2).toFixed(2);
  pics.style.filter = `brightness(${(0.9 + (b / 100) * 0.1).toFixed(2)}) saturate(${night ? 0.85 : 1})`;
  day.style.setProperty("--hours-track", `rgb(${r} ${g} ${bl})`);
}

// Start at the visitor's own time of day.
const now = new Date();
day.value = Math.round((now.getHours() * 60 + now.getMinutes()) / 10) * 10;
paint(+day.value);
day.addEventListener("input", () => paint(+day.value));

// The stage changes photograph as each part of the reading column arrives.
const shots = [...document.querySelectorAll(".stage__img")];
const scenes = [...document.querySelectorAll("[data-scene]")];
let current = 0;
const sceneObs = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const n = +e.target.dataset.scene;
    if (n === current || !shots[n]) continue;
    shots[current].classList.remove("is-on");
    shots[n].classList.add("is-on");
    current = n;
  }
}, { rootMargin: "-45% 0px -45% 0px" });
scenes.forEach((s) => sceneObs.observe(s));

// Pause the slow drift when the tab is hidden.
document.addEventListener("visibilitychange", () => {
  shots.forEach((s) => (s.style.animationPlayState = document.hidden ? "paused" : "running"));
});

// Dashboard tabs.
const PLATES = {
  now: {
    img: "assets/ui-now.jpg",
    alt: "Hearth's dashboard right now: the answer in large type, the floor plan and every reading on a deep green panel",
    h: "One answer, first",
    p: "The dashboard opens with the one thing that matters now, in plain words, then the floor plan and every reading underneath. Buttons let you cook dinner or spill some water and watch the house respond.",
  },
  history: {
    img: "assets/ui-history.jpg",
    alt: "Hearth's history chart of the living room temperature beside the open alerts",
    h: "What happened, and when",
    p: "Any room's last five minutes or last six hours, with its limit drawn on the chart. Beside it, the open alerts and the ones that cleared on their own, each with how long it lasted.",
  },
  light: {
    img: "assets/ui-light.jpg",
    alt: "Hearth's lighting schedule: colour temperature and brightness for every half hour of the day",
    h: "Light that follows the day",
    p: "Every half hour of the day as a bar: its colour is the colour temperature, its height the brightness. Drag across it to see what the lights will do at any hour.",
  },
};
const plate = document.getElementById("plate-img");
const showH = document.getElementById("show-h");
const showP = document.getElementById("show-p");
const tabs = [...document.querySelectorAll("[data-tab]")];
tabs.forEach((tab) => tab.addEventListener("click", () => {
  const d = PLATES[tab.dataset.tab];
  tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
  plate.classList.add("is-swap");
  setTimeout(() => {
    plate.src = d.img; plate.alt = d.alt; showH.textContent = d.h; showP.textContent = d.p;
    plate.onload = () => plate.classList.remove("is-swap");
    if (plate.complete) plate.classList.remove("is-swap");
  }, reduce ? 0 : 260);
}));
tabs.forEach((t) => { const i = new Image(); i.src = PLATES[t.dataset.tab].img; });

// Entrances: the parts of a section arrive one after another.
const groups = new Map();
document.querySelectorAll("[data-in]").forEach((el) => {
  const sec = el.closest("section") || document.body;
  const list = groups.get(sec) || [];
  el.style.setProperty("--i", list.length);
  list.push(el);
  groups.set(sec, list);
});
const inObs = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-in"); inObs.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll("[data-in]").forEach((el) => inObs.observe(el));
