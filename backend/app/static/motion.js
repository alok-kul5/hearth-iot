// Hearth's motion: the opening, the arrival of each part, and the feedback on everything you can touch.
//
// One signature curve (expo out) for arrivals, one ease-in-out for things that travel across the screen,
// three durations: 200 ms feedback, 500 ms moving into place, 900-1000 ms reveals.
//
// The opening: a deep-green field counts the sensors in with a large figure, then folds down into the
// hero's own rectangle (it is the same green, so the fold is seamless). As it folds, the top bar drops in
// and the page around it rises; once it lands, the answer rolls up word by word, the rooms assemble,
// the figures count up and the bars fill. Anything below the fold arrives when it is scrolled to.
// With prefers-reduced-motion there is no curtain and nothing travels; the feedback that remains is colour.
(() => {
  "use strict";
  const EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";
  const IO = "cubic-bezier(0.76, 0, 0.24, 1)";
  const body = document.body;
  const curtain = document.getElementById("curtain");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(pointer: fine)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Arrivals hold their first frame through the delay, then hand back to CSS (fill: backwards).
  const anim = (el, frames, opts) => el?.animate(frames, { easing: EXPO, fill: "backwards", ...opts });
  const rise = (el, delay, dist = 18, duration = 800) => anim(el, [{ opacity: 0, transform: `translateY(${dist}px)` }, { opacity: 1, transform: "none" }], { duration, delay });
  const all = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ── Section nav: a pill that follows the pointer and rests on the section in view ── */
  const nav = document.getElementById("jump");
  const pill = nav?.querySelector(".jump-pill");
  const links = all("a", nav ?? document.createElement("i"));
  let current = links[0];
  function pillTo(a) {
    if (!pill || !a || !a.offsetWidth) return;
    pill.style.width = `${a.offsetWidth}px`;
    pill.style.transform = `translateX(${a.offsetLeft}px)`;
    pill.style.opacity = "1";
  }
  /* ── Views: each section is its own page; only one is shown at a time ── */
  // They live in one document so the simulated house keeps running between pages. The address carries
  // the view (#history), so links, the back button and sharing all work.
  const VIEW_NAMES = ["now", "history", "light", "sensors", "rules"];
  const viewOf = (hash) => { const v = (hash || "").replace(/^#/, ""); return VIEW_NAMES.includes(v) ? v : "now"; };
  const viewEls = (v) => all(`main [data-view="${v}"]`);
  let view = null;
  function showView(v) {
    view = v;
    all("main [data-view]").forEach((el) => { el.hidden = el.dataset.view !== v; });
    body.dataset.view = v;
    current = links.find((l) => l.getAttribute("href") === `#${v}`) ?? links[0];
    links.forEach((l) => { l.classList.toggle("on", l === current); l.toggleAttribute("aria-current", l === current); });
    if (!nav?.matches(":hover")) pillTo(current);
    // Charts and the light strip measure their width, so they redraw once their page is visible.
    dispatchEvent(new Event("resize"));
    window.renderChart?.();
    return viewEls(v)[0];
  }
  window.showView = showView;
  showView(viewOf(location.hash));

  if (nav) {
    links.forEach((a) => a.addEventListener("pointerenter", () => pillTo(a)));
    nav.addEventListener("pointerleave", () => pillTo(current));
    document.fonts?.ready.then(() => pillTo(current));
    addEventListener("resize", () => pillTo(current));
  }

  // Changing page works like the opening. The pill grows into a field in the colour of the page you asked
  // for, that page's own live figure counts up on it, the page changes behind it, and the field folds down
  // into the page's main card, so it lands as the thing it was showing you.
  let busy = false;
  const FIGURES = {
    now: () => ({ n: state.sensors.size || 17, dec: 0, unit: "", cap: "sensors reporting<br>right now" }),
    history: () => {
      const v = document.getElementById("lead-value")?.textContent ?? "";
      const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
      return { n: m ? +m[0] : 0, dec: m?.[1] ? m[1].length - 1 : 0, unit: v.replace(/[-\d.,\s]/g, "").trim(),
               cap: `${document.getElementById("chart-h")?.textContent ?? "History"},<br>last 15 minutes` };
    },
    light: () => {
      const k = +(document.getElementById("light-k")?.textContent ?? "").replace(/[^\d]/g, "") || 0;
      return { n: k, dec: 0, unit: "K", cap: "the living room light,<br>right now" };
    },
    sensors: () => {
      const t = document.getElementById("online-count")?.textContent ?? "";
      const m = t.match(/(\d+)\D+(\d+)/);
      return { n: m ? +m[1] : state.sensors.size, dec: 0, unit: "", cap: `of ${m ? m[2] : state.sensors.size} sensors<br>online` };
    },
    rules: () => ({ n: document.querySelectorAll("#rules-body tr").length || 12, dec: 0, unit: "", cap: "rules, each one<br>written down" }),
  };
  const NAMES = { now: "Now", history: "History", light: "Light", sensors: "Sensors", rules: "Rules" };
  const fmtN = (v, dec) => v.toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const rectInset = (r, round) => `inset(${Math.max(0, r.top)}px ${Math.max(0, innerWidth - r.right)}px ${Math.max(0, innerHeight - r.bottom)}px ${Math.max(0, r.left)}px round ${round})`;

  async function go(v, fromEl) {
    if (v === view && scrollY < 40) return;
    if (location.hash !== `#${v}`) history.pushState(null, "", `#${v}`);
    if (reducedMotion || busy || body.classList.contains("intro") || !document.querySelector(".hero")) {
      showView(v); scrollTo({ top: 0, behavior: "instant" }); return;
    }
    busy = true;
    const link = links.find((l) => l.getAttribute("href") === `#${v}`);
    if (link) { links.forEach((l) => l.classList.toggle("on", l === link)); pillTo(link); }

    const main = viewEls(v)[0];
    const wasHidden = main.hidden; main.hidden = false;
    const cs = getComputedStyle(main);
    const ground = cs.backgroundColor, ink = cs.color;
    main.hidden = wasHidden;
    // The light's page opens in the light's own colour, then settles into its card.
    const bulb = v === "light" ? getComputedStyle(document.getElementById("bulb")).backgroundColor : null;
    const fig = FIGURES[v]();
    const field = document.createElement("div");
    field.className = "transit";
    field.style.background = bulb ?? ground; field.style.color = ink;
    field.innerHTML = `<p class="transit-word">${NAMES[v]}</p>
      <div class="transit-count"><span class="transit-n">${fmtN(0, fig.dec)}</span>${fig.unit ? `<span class="transit-unit">${fig.unit}</span>` : ""}<span class="transit-cap">${fig.cap}</span></div>
      <span class="transit-line"><span></span></span>`;
    document.body.append(field);
    const num = field.querySelector(".transit-n"), line = field.querySelector(".transit-line span");
    const parts = [field.querySelector(".transit-word"), field.querySelector(".transit-count")];

    // 1. Whatever was clicked grows to fill the screen.
    const src = fromEl ?? (pill && pill.getBoundingClientRect().width ? pill : link);
    const from = src ? src.getBoundingClientRect() : { top: innerHeight / 2, left: innerWidth / 2, right: innerWidth / 2, bottom: innerHeight / 2 };
    const grow = anim(field, [{ clipPath: rectInset(from, "999px") }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 640, easing: IO, fill: "forwards" });
    // 2. The page's figure counts up as it opens.
    parts.forEach((p, i) => anim(p, [{ opacity: 0, transform: "translateY(26px)" }, { opacity: 1, transform: "none" }], { duration: 700, delay: 300 + i * 60, fill: "both" }));
    const t0 = performance.now() + 340, COUNT = 760;
    await new Promise((done) => {
      const tick = (now) => {
        const k = Math.min(1, Math.max(0, (now - t0) / COUNT)), eased = 1 - Math.pow(1 - k, 4);
        num.textContent = fmtN(fig.n * eased, fig.dec);
        line.style.transform = `scaleX(${Math.max(0.02, eased)})`;
        k < 1 ? requestAnimationFrame(tick) : done();
      };
      requestAnimationFrame(tick);
    });
    await grow.finished;
    // 3. Behind the field, the page changes.
    showView(v);
    scrollTo({ top: 0, behavior: "instant" });
    viewEls(v).forEach((el) => el.classList.remove("waiting"));
    await wait(200);
    // 4. The figure leaves upward and the field folds into the page's main card.
    anim(parts[1], [{ transform: "none", opacity: 1 }, { transform: "translateY(-48px)", opacity: 0 }], { duration: 480, easing: "cubic-bezier(0.7, 0, 0.84, 0)", fill: "forwards" });
    anim(parts[0], [{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: "forwards" });
    anim(field.querySelector(".transit-line"), [{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: "forwards" });
    const to = main.getBoundingClientRect(), FOLD = 900;
    anim(field, [{ clipPath: "inset(0px 0px 0px 0px round 0px)", background: bulb ?? ground }, { clipPath: rectInset(to, "18px"), background: ground }], { duration: FOLD, delay: 160, easing: IO, fill: "forwards" });
    const land = 160 + Math.round(FOLD * 0.85);
    // 5. As it lands, the page's own parts take over, the way the hero assembles after the opening.
    const els = viewEls(v);
    const inside = main.matches(".hero")
      ? all(".hero-read > *, .plan-head, .plan-wrap, .readings-head, #tiles .tile", main)
      : all(":scope > header, .panel-head, .chart-lead, .chart, .light-now, .daystrip, .sensor-list li, tbody tr", main).slice(0, 18);
    inside.forEach((el, i) => anim(el, [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: 700, delay: land - 120 + Math.min(i, 12) * 45 }));
    // The page's other cards and the footer rise in beside it.
    [...els.slice(1), document.querySelector(".foot")].forEach((el, i) => el && anim(el, [{ opacity: 0, transform: "translateY(32px)" }, { opacity: 1, transform: "none" }], { duration: 900, delay: land - 60 + i * 90 }));
    if (v === "history") setTimeout(() => { renderChart.drawIn = true; renderChart(); }, land);
    await wait(land);
    field.remove();
    busy = false;
  }

  links.forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); go(viewOf(a.getAttribute("href"))); }));
  // Links inside the pages that point at another page.
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href="#log-h"]');
    if (a) { e.preventDefault(); go("sensors", a); }
  });
  // Picking a room on the plan, or a sensor in the list, opens its history.
  document.addEventListener("click", (e) => {
    const pick = e.target.closest("#plan .room[data-sensor], #sensors-list button");
    if (pick && view !== "history") setTimeout(() => go("history", pick), 0);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest?.("#plan .room[data-sensor]") && view !== "history") setTimeout(() => go("history", e.target), 0);
  });
  addEventListener("popstate", () => { showView(viewOf(location.hash)); scrollTo({ top: 0, behavior: "instant" }); });

  if (reducedMotion) {
    curtain?.remove();
    body.classList.remove("intro");
    return;
  }

  /* ── The opening ───────────────────────────────────── */
  const n = document.getElementById("curtain-n"), bar = document.getElementById("curtain-bar");
  const started = performance.now();
  async function opening() {
    // Count the sensors as they check in, one at a time, so it reads as a count.
    let shown = 0;
    while (performance.now() - started < 2800) {
      const total = state.sensors.size || 17;
      if (shown < state.sensors.size) shown += 1;
      n.textContent = String(shown).padStart(2, "0");
      document.getElementById("curtain-total").textContent = total;
      bar.style.transform = `scaleX(${Math.max(0.02, shown / total)})`;
      if (shown >= total && state.sensors.size && performance.now() - started > 1000) break;
      await wait(52);
    }
    await wait(260);
    fold();
  }

  function fold() {
    const hero = viewEls(view)[0] ?? document.querySelector(".hero");
    const r = hero.getBoundingClientRect();
    const inset = `inset(${r.top}px ${innerWidth - r.right}px ${Math.max(0, innerHeight - r.bottom)}px ${r.left}px round 18px)`;
    const FOLD = 1000;
    // The figure and the words leave first, upward; the field then folds into the hero.
    anim(curtain.querySelector(".curtain-count"), [{ transform: "none", opacity: 1 }, { transform: "translateY(-48px)", opacity: 0 }], { duration: 520, easing: "cubic-bezier(0.7, 0, 0.84, 0)", fill: "forwards" });
    anim(curtain.querySelector(".curtain-word"), [{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" });
    anim(curtain.querySelector(".curtain-line"), [{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" });
    anim(curtain, [{ clipPath: "inset(0px 0px 0px 0px round 0px)" }, { clipPath: inset }], { duration: FOLD, delay: 200, easing: IO, fill: "forwards" });

    body.classList.remove("intro");
    // The field has all but landed at 85% of the fold (the curve is nearly flat there), so the curtain
    // goes then and the hero's own contents take over without a pause.
    const T = 200 + Math.round(FOLD * 0.85);
    setTimeout(() => curtain.remove(), T);
    anim(document.querySelector(".bar"), [{ opacity: 0, transform: "translateY(-14px)" }, { opacity: 1, transform: "none" }], { duration: 800, delay: 520 });
    heroArrives(T);
    // Panels already on screen rise as the field lands; the rest wait to be scrolled to.
    let k = 0;
    for (const p of all(".reveal")) {
      if (p.getBoundingClientRect().top < innerHeight - 30) reveal(p, T - 200 + k++ * 110);
      else { p.classList.add("waiting"); observer.observe(p); }
    }
  }

  /* ── The hero assembles in reading order ───────────── */
  function heroArrives(T) {
    all("#page-title .w > span").forEach((w, i) => anim(w, [{ transform: "translateY(108%)" }, { transform: "none" }], { duration: 1000, delay: T + i * 70 }));
    rise(document.getElementById("summary"), T + 260, 16);
    rise(document.querySelector(".try-h"), T + 380, 10, 600);
    all("#try button").forEach((b, i) => anim(b, [{ opacity: 0, transform: "translateY(18px) scale(0.94)" }, { opacity: 1, transform: "none" }], { duration: 800, delay: T + 430 + i * 60 }));
    rise(document.getElementById("hero-note"), T + 700, 10, 700);

    rise(document.querySelector(".plan-head"), T + 120, 10, 600);
    all("#plan .room").forEach((g, i) => {
      anim(g, [{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "none" }], { duration: 900, delay: T + 160 + i * 70 });
      countIn(g.querySelector(".reading[data-num]"), T + 260 + i * 70);
    });
    all("#plan .door, #plan .door-frame, #plan .door-swing").forEach((el) => anim(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: T + 620 }));
    anim(document.querySelector("canvas.living"), [{ opacity: 0 }, { opacity: 1 }], { duration: 1400, delay: T + 600, easing: "ease-out" });

    rise(document.querySelector(".readings-head"), T + 360, 10, 600);
    anim(document.querySelector(".readings-head"), [{ borderBottomColor: "transparent" }, { borderBottomColor: "rgba(238, 241, 236, 0.16)" }], { duration: 900, delay: T + 400 });
    all("#tiles .tile").forEach((t, i) => {
      rise(t, T + 440 + i * 65, 22, 900);
      countIn(t.querySelector(".t-value[data-num]"), T + 480 + i * 65);
      const fill = t.querySelector(".t-fill");
      if (fill) anim(fill, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 1300, delay: T + 620 + i * 65 });
      const tick = t.querySelector(".t-limit");
      if (tick) anim(tick, [{ opacity: 0, transform: "scaleY(0)" }, { opacity: 1, transform: "none" }], { duration: 500, delay: T + 1000 + i * 65 });
    });
  }

  // A figure counts up from zero with the dashboard's own counter, which live readings cannot interrupt.
  function countIn(el, delay) { if (el) window.countIn?.(el, delay, 1100); }

  /* ── How each panel arrives ────────────────────────── */
  function reveal(p, delay = 0) {
    p.classList.remove("waiting");
    anim(p, [{ opacity: 0, transform: "translateY(36px)" }, { opacity: 1, transform: "none" }], { duration: 1000, delay });
    const d = delay + 160;
    p.querySelectorAll(":scope > header, .light-read > header, .panel-head").forEach((h) => rise(h, d, 10, 700));

    if (p.querySelector("#chart")) {
      leadShown = { id: state.selected, value: 0 };   // the big figure counts up from zero
      setTimeout(() => { renderChart.drawIn = true; renderChart(); }, d + 120);
      rise(p.querySelector(".chart-lead"), d + 80, 12, 700);
    }
    if (p.querySelector("#alerts")) all("#alerts > li", p).forEach((li, i) => anim(li, [{ opacity: 0, transform: "translateX(20px)" }, { opacity: 1, transform: "none" }], { duration: 700, delay: d + 120 + i * 60 }));
    if (p.querySelector("#daystrip")) {
      const strip = document.getElementById("daystrip");
      anim(document.getElementById("bulb"), [{ transform: "scale(0)" }, { transform: "scale(1.1)", offset: 0.65 }, { transform: "scale(1)" }], { duration: 900, delay: d + 120 });
      rise(p.querySelector(".light-now > div"), d + 180, 12, 700);
      strip.style.setProperty("--d", `${d + 160}ms`);
      strip.classList.add("grow");
      setTimeout(() => strip.classList.remove("grow"), d + 160 + 48 * 12 + 1000);
    }
    p.querySelectorAll(".sensor-list li, tbody tr").forEach((row, i) => rise(row, d + 120 + Math.min(i, 14) * 35, 8, 600));
    if (p.classList.contains("foot")) {
      const word = p.querySelector(".foot-word");
      if (!word.children.length) word.innerHTML = [...word.textContent].map((c) => `<span>${c}</span>`).join("");
      all("span", word).forEach((s, i) => anim(s, [{ opacity: 0, transform: "translateY(40%)" }, { opacity: 1, transform: "none" }], { duration: 1100, delay: delay + 120 + i * 70 }));
      rise(p.querySelector(".foot-row"), delay + 500, 10, 700);
    }
  }
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); if (e.target.classList.contains("waiting")) reveal(e.target, 0); }
  }, { rootMargin: "0px 0px -10% 0px" });

  /* ── Transitions after the opening ─────────────────── */
  // Switching sensor: the chart's name and figure roll in from below while the line redraws.
  const baseSelect = select;
  select = function (id) {  // eslint-disable-line no-global-assign
    const changed = id !== state.selected;
    baseSelect(id);
    if (!changed) return;
    for (const el of [document.getElementById("chart-h"), document.querySelector(".chart-lead")])
      anim(el, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 550 });
  };

  // A press leaves a ripple where the finger or pointer landed.
  document.addEventListener("pointerdown", (e) => {
    const host = e.target.closest(".tile, .try-buttons button, .sensor-list button, .segmented button");
    if (!host) return;
    const r = host.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2.2;
    const dot = document.createElement("span");
    dot.className = "ripple";
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    host.append(dot);
    anim(dot, [{ transform: "scale(0)", opacity: 0.28 }, { transform: "scale(1)", opacity: 0 }], { duration: 700, fill: "forwards" }).finished.then(() => dot.remove());
  });

  if (finePointer) {
    // The try-it pills lean towards the pointer when it comes near (the CSS `translate` property,
    // so the press scale on `transform` still works).
    const pills = () => all("#try button");
    let raf = 0, px = -1e4, py = -1e4;
    const lean = () => {
      raf = 0;
      for (const b of pills()) {
        const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const dx = px - cx, dy = py - cy, reach = Math.max(r.width, r.height) * 0.9;
        const near = Math.abs(dx) < r.width / 2 + 24 && Math.abs(dy) < r.height / 2 + 24 && Math.hypot(dx, dy) < reach;
        b.style.translate = near ? `${(dx * 0.14).toFixed(1)}px ${(dy * 0.22).toFixed(1)}px` : "";
      }
    };
    document.addEventListener("pointermove", (e) => { px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(lean); }, { passive: true });
    const style = document.createElement("style");
    style.textContent = "#try button { transition: background 0.25s, transform 0.5s cubic-bezier(0.16,1,0.3,1), translate 0.6s cubic-bezier(0.16,1,0.3,1); }";
    document.head.append(style);

    // Over a room, a small label follows the pointer and says what a click does.
    const label = document.getElementById("cursor-label");
    const plan = document.getElementById("plan");
    let lx = 0, ly = 0, tx = 0, ty = 0, follow = 0;
    const glide = () => {
      lx += (tx - lx) * 0.22; ly += (ty - ly) * 0.22;
      label.style.translate = `${lx.toFixed(1)}px ${ly.toFixed(1)}px`;
      follow = Math.abs(tx - lx) + Math.abs(ty - ly) > 0.3 ? requestAnimationFrame(glide) : 0;
    };
    plan.addEventListener("pointermove", (e) => {
      const g = e.target.closest(".room[data-sensor]");
      if (!g || !g.dataset.sensor || e.pointerType !== "mouse") { label.classList.remove("on"); return; }
      const name = ROOMS[g.dataset.room]?.label ?? "Room";
      const text = `${name} history`;
      if (label.textContent !== text) label.textContent = text;
      tx = e.clientX + 18; ty = e.clientY + 22;
      if (!label.classList.contains("on")) { lx = tx; ly = ty; label.classList.add("on"); }
      if (!follow) follow = requestAnimationFrame(glide);
    });
    plan.addEventListener("pointerleave", () => label.classList.remove("on"));
  }

  // A reading that tips over its limit gives its tile a short shake, the way an alarm would.
  new MutationObserver((list) => {
    for (const m of list) {
      const t = m.target;
      if (t.classList?.contains("t-value") && t.classList.contains("poor") && !(m.oldValue ?? "").includes("poor"))
        anim(t, [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }], { duration: 400, easing: "ease-in-out", fill: "none" });
    }
  }).observe(document.getElementById("tiles"), { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });

  // Wait for the dashboard's first data, then run the opening.
  (async () => {
    while (!state.sensors.size && performance.now() - started < 2400) await wait(40);
    await wait(60);
    opening();
  })();
})();
