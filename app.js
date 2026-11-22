// Окно «детектора»: прибор, скан, компас к лучшему месту, звук. Расчёты — в core.js.
import { altHint, altTrend, bearing, confidence, distance, median, offset, plausible, route, exactBits, fmt, gaugePos, grade, hint, mbps, places, side, speedParts, toCSV } from "./core.js";

// Предохранитель: ответ засчитываем, только если он пришёл от сервера замера, а не от страницы входа Wi-Fi и т.п.
let portal = false;
function genuine(r) { const ok = r.ok && (r.headers.get("content-type") || "").includes("octet-stream"); if (!ok) portal = true; return ok; }

const sp = (v) => { const p = speedParts(v); return `${p.value} ${p.unit}`; };

const KEY = "gdeLovit.v1";
const TEST_URL = "https://speed.cloudflare.com/__down?bytes=";
const $ = (id) => document.getElementById(id);

// ---------- Хранилище (только в этом телефоне) ----------
function load() {
  const empty = { measures: [], usedBytes: 0, eco: false, sound: true };
  try { return { ...empty, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return empty; }
}
let S = load();
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast("Не удалось сохранить в памяти телефона"); } }

// ---------- Прибор ----------
const TICKS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100];
const LABELS = { 0.001: "1к", 0.01: "10к", 0.1: "100к", 1: "1М", 10: "10М", 100: "100М" };
(function drawTicks() {
  let html = "";
  for (const v of TICKS) {
    const a = Math.PI * (1 - gaugePos(v));
    const major = v in LABELS;
    const [r1, r2] = major ? [100, 116] : [106, 116];
    const x1 = 150 + r1 * Math.cos(a), y1 = 150 - r1 * Math.sin(a), x2 = 150 + r2 * Math.cos(a), y2 = 150 - r2 * Math.sin(a);
    html += `<line class="tick${major ? "" : " minor"}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    if (major) html += `<text x="${150 + 86 * Math.cos(a)}" y="${150 - 86 * Math.sin(a) + 4}" text-anchor="middle">${LABELS[v]}</text>`;
  }
  $("ticks").innerHTML = html;
  $("bar").innerHTML = "<i></i>".repeat(12);
})();

function setGauge(speed, live = false) {
  const t = gaugePos(speed);
  $("needle").style.transform = `rotate(${-90 + 180 * t}deg)`;
  const n = speed > 0 ? Math.max(1, Math.round(t * 12)) : 0;
  [...$("bar").children].forEach((el, i) => { el.className = i < n ? (i < 3 ? "r" : i < 6 ? "a" : i < 9 ? "l" : "g") : ""; });
  const p = speedParts(speed);
  $("val").textContent = p.value;
  $("unit").textContent = p.unit;
  $("exact").textContent = `ТОЧНО: ${exactBits(speed)} бит/с`;
  if (S.sound && live) geigerRate(t);
}

// ---------- Звук: треск как у счётчика Гейгера ----------
let ac = null, geigerTimer = null, rate = 0;
function audio() { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { ac = null; } } return ac; }
function click(freq = 1800, len = 0.012, vol = 0.25) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = "square"; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + len);
  o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + len + 0.01);
}
function geigerRate(t) { rate = 1 + t * 28; }
function geigerStart() {
  if (!S.sound) return;
  rate = 1;
  const tick = () => { click(1200 + Math.random() * 1500); geigerTimer = setTimeout(tick, (1000 / rate) * (0.4 + Math.random() * 1.2)); };
  tick();
}
function geigerStop() { clearTimeout(geigerTimer); geigerTimer = null; }
function resultBeep(level) {
  if (S.sound) for (let i = 0; i < level; i++) setTimeout(() => click(500 + level * 250, 0.09, 0.3), i * 150);
  try { navigator.vibrate?.(Array.from({ length: level }, () => [70, 70]).flat()); } catch { /* нет вибрации */ }
}

// ---------- Замер ----------
function where() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );
  });
}

// Пинг: при слабой связи ждём до 12 с. Если первая попытка не прошла — связи нет, не мучаем.
async function ping() {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    try {
      const r = await fetch(TEST_URL + "0&r=" + Math.random(), { cache: "no-store", signal: AbortSignal.timeout(12000) });
      await r.arrayBuffer();
      if (!genuine(r)) throw new Error("не тот сервер");
      times.push(performance.now() - t);
    } catch { if (!times.length) break; }
  }
  return times.length ? Math.round(Math.min(...times)) : null;
}

// Загрузка: при слабой связи (долгий пинг) даём больше времени, чтобы поймать хоть какие-то биты.
async function download(pingMs, opt = {}) {
  const weak = pingMs > 800;
  const maxBytes = opt.maxBytes ?? (S.eco ? 1_000_000 : 5_000_000);
  const maxMs = opt.maxMs ?? (weak ? 12000 : S.eco ? 4000 : 6000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  const t0 = performance.now();
  let got = 0;
  try {
    const r = await fetch(TEST_URL + maxBytes + "&r=" + Math.random(), { cache: "no-store", signal: ctrl.signal });
    if (!genuine(r)) { clearTimeout(timer); return { bytes: 0, ms: performance.now() - t0 }; }
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > maxBytes + 65536) { got = 0; break; } // пришло больше, чем просили, — это не наш замер
      const el = performance.now() - t0;
      if (el > 300) setGauge(mbps(got, el), true);
      if (!opt.quiet) $("status").textContent = `СКАНИРУЮ… ${Math.round(got / 1024)} КБ`;
    }
  } catch { /* остановили по времени — считаем то, что успело скачаться */ }
  clearTimeout(timer);
  return { bytes: got, ms: performance.now() - t0 };
}

let busy = false;
function badMeasure() {
  $("word").textContent = "ОШИБКА ЗАМЕРА";
  $("exact").textContent = "Число получилось невозможным — оно не сохранено";
  $("status").textContent = "Нажмите СКАН ещё раз";
  setGauge(0);
  finishScan();
}
function finishScan() {
  if (!searching) { geigerStop(); document.querySelector(".gaugebox").classList.remove("scanning"); }
  $("go").classList.remove("busy");
  busy = false;
}
async function measure() {
  if (busy) return;
  busy = true;
  portal = false;
  $("go").classList.add("busy");
  document.querySelector(".gaugebox").classList.add("scanning");
  $("word").textContent = "СКАН";
  $("status").textContent = "ИЩУ МЕСТО И СВЯЗЬ…";
  setGauge(0, true);
  if (!searching) geigerStart();
  const geoP = where();
  const p = await ping();
  $("ping").textContent = p ?? "---";
  const d = p == null ? { bytes: 0, ms: 0 } : await download(p);
  const geo = await geoP;
  if (!searching) geigerStop();
  const speed = d.bytes > 0 ? mbps(d.bytes, d.ms) : 0;
  const m = {
    time: Date.now(), mbps: speed, ping: p, ok: p != null, bytes: d.bytes, ms: Math.round(d.ms),
    lat: geo?.lat ?? null, lon: geo?.lon ?? null, acc: geo?.acc ?? null, alt: geo?.alt ?? null,
    net: netInfo(), label: $("label").value.trim().slice(0, 40),
  };
  if (geo) here = { lat: geo.lat, lon: geo.lon };
  S.usedBytes += d.bytes;
  if (!plausible(m)) { badMeasure(); return; }
  S.measures.push(m);
  save();
  showNow(m);
  render();
  if (!searching) document.querySelector(".gaugebox").classList.remove("scanning");
  $("go").classList.remove("busy");
  busy = false;
}

function netInfo() {
  const c = navigator.connection;
  return c ? [c.type, c.effectiveType].filter(Boolean).join(" ") : "";
}

// ---------- ПОИСК: непрерывно, лёгкими замерами ----------
// Каждые ~3 с: пинг + короткая загрузка (до 150 КБ, в ЭКО до 30 КБ). Стрелка и треск живые.
// Когда связь появляется после «нет связи» — тревожный сигнал. Точки на карту — каждые 10 м или 20 с.
let searching = false, prevOk = null, lastRec = null;
const recent = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  const t = performance.now();
  let p = null;
  try {
    const r = await fetch(TEST_URL + "0&r=" + Math.random(), { cache: "no-store", signal: AbortSignal.timeout(8000) });
    await r.arrayBuffer();
    if (genuine(r)) p = Math.round(performance.now() - t);
  } catch { /* нет связи */ }
  if (p == null) return { ok: false, mbps: 0, ping: null, bytes: 0, ms: 0 };
  const d = await download(p, { maxBytes: S.eco || S.forest ? 30_000 : 150_000, maxMs: p > 800 ? 6000 : 2500, quiet: true });
  return { ok: true, ping: p, bytes: d.bytes, ms: Math.round(d.ms), mbps: d.bytes ? mbps(d.bytes, d.ms) : 0 };
}

async function searchLoop() {
  document.querySelector(".gaugebox").classList.add("scanning");
  geigerStart();
  while (searching) {
    const t0 = performance.now();
    if (!busy) {
      portal = false;
      const raw = await probe();
      if (!searching) break;
      S.usedBytes += raw.bytes;
      if (!plausible(raw)) { await sleep(1000); continue; }
      if (raw.ok) recent.push(raw.mbps); else recent.length = 0;
      if (recent.length > 3) recent.shift();
      const r = raw.ok ? { ...raw, mbps: median(recent) } : raw; // середина из последних 3 — без случайных скачков
      const m = { time: Date.now(), ...r, lat: here?.lat ?? null, lon: here?.lon ?? null, acc: hereAcc, alt: hereAlt, net: netInfo(), label: $("label").value.trim().slice(0, 40) };
      showNow(m, true);
      geigerRate(r.ok ? gaugePos(r.mbps) : 0);
      if (prevOk === false && r.ok) alarm();
      prevOk = r.ok;
      const far = !lastRec || (m.lat != null && lastRec.lat != null ? distance(lastRec, m) >= 10 : false) || Date.now() - lastRec.time >= 20000;
      if (far) { S.measures.push(m); lastRec = m; render(); }
      save();
      $("status").textContent = `ПОИСК… ${r.ok ? grade(r.mbps).can : "связи нет — идите выше или на открытое место"}`;
    }
    await sleep(Math.max(300, (S.forest ? 15000 : 3000) - (performance.now() - t0)));
  }
  geigerStop();
  document.querySelector(".gaugebox").classList.remove("scanning");
}

function alarm() {
  toast("📶 СВЯЗЬ ПОЯВИЛАСЬ! Остановитесь здесь");
  if (S.sound) for (let i = 0; i < 6; i++) setTimeout(() => click(i % 2 ? 1400 : 900, 0.18, 0.4), i * 220);
  try { navigator.vibrate?.([300, 120, 300, 120, 600]); } catch { /* нет вибрации */ }
}

let wake = null;
async function setSearch(on) {
  searching = on;
  S.search = on; save();
  if (on) {
    prevOk = null; lastRec = null;
    searchLoop();
    try { wake = await navigator.wakeLock?.request("screen"); } catch { /* не поддерживается */ }
    toast("ПОИСК включён: идите — детектор ищет связь сам");
  } else {
    try { await wake?.release(); } catch { /* ок */ }
    wake = null;
  }
}

function showNow(m, quiet = false) {
  if (!m.ok) {
    setGauge(0);
    $("word").textContent = "НЕТ СВЯЗИ";
    $("ping").textContent = "---";
    $("exact").textContent = quiet ? "ТОЧНО: 0 бит/с · сервер не ответил" : "ТОЧНО: 0 бит/с · сервер не ответил за 12 с";
    $("status").textContent = portal ? "Ответил не сервер замера — возможно, Wi-Fi просит вход (откройте браузер)" : "Попробуйте выше или на открытом месте. Экстренно: 112 — работает через любого оператора";
    $("ledNet").className = "led off";
    if (!quiet) resultBeep(1);
    return;
  }
  const g = grade(m.mbps);
  setGauge(m.mbps);
  $("word").textContent = g.word.toUpperCase();
  $("ping").textContent = m.ping;
  $("ledNet").className = "led " + (g.level >= 3 ? "on" : "warn");
  $("ledGps").className = "led " + (m.lat == null ? "off" : m.acc > 30 ? "warn" : "on");
  const c = confidence(m.bytes, m.ms);
  m.conf = c.level;
  if (c.level <= 1) $("val").textContent = "≈" + $("val").textContent;
  $("exact").textContent = `ТОЧНО: ${exactBits(m.mbps)} бит/с · ${String(m.bytes).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} Б за ${(m.ms / 1000).toFixed(2).replace(".", ",")} с · ДОСТОВЕРНОСТЬ: ${c.word.toUpperCase()}`;
  $("status").textContent = `Можно: ${g.can}. ` + (m.lat == null ? "Место не определено — разрешите геолокацию" : `Записано, место ±${Math.round(m.acc)} м`);
  if (!quiet) resultBeep(g.level);
}

// ---------- Цель и списки ----------
let here = null, hereAcc = null, hereAlt = null, heading = null;
function render() {
  const P = places(S.measures);
  const b = P[0];
  path = here ? route(here, P) : [];
  const next = path[0];
  if (b && here && next) {
    const d = distance(here, next);
    const total = path.reduce((s, p, i) => s + distance(i ? path[i - 1] : here, p), 0);
    const g = grade(next.speed);
    const last = next === b;
    $("tdist").textContent = d < 8 ? (last ? "ВЫ В ЗОНЕ" : "ТОЧКА ВЗЯТА") : (d < 1000 ? `${Math.round(d)} м` : `${fmt(d / 1000)} км`) + ` → ${side(bearing(here, next)).toUpperCase()}`;
    $("tinfo").innerHTML = `<span class="dot lv${g.level}" style="display:inline-block"></span> ${last ? "ЦЕЛЬ" : `ТОЧКА 1 из ${path.length}`} · <b>${sp(next.speed)}</b>${next.label ? " · " + esc(next.label) : ""}`;
    const ah = altHint(hereAlt, next.alt);
    $("tnote").textContent = (heading == null ? "Радар повёрнут севером вверх" : "Радар поворачивается вместе с телефоном") + (ah && d >= 8 ? ` · ${ah}` : "");
    $("tgoal").textContent = last ? "" : `ЦЕЛЬ: ${sp(b.speed)}${b.label ? " · " + b.label : ""} · путь ${Math.round(total)} м по пройденным точкам`;
    // Дошли до точки — короткий сигнал (один раз на точку).
    const key = `${next.lat.toFixed(5)},${next.lon.toFixed(5)}`;
    if (lastNext && lastNext !== key) { if (S.sound) click(1600, 0.08, 0.3); try { navigator.vibrate?.(80); } catch { /* нет */ } }
    lastNext = key;
  } else {
    $("tdist").textContent = "—";
    $("tinfo").textContent = b ? `Лучшее место: ${sp(b.speed)}${b.label ? " · " + b.label : ""}` : "Нет замеров с местоположением";
    $("tnote").textContent = b ? "Нажмите СКАН или включите ПОИСК — локатор поведёт" : "Сделайте замеры в разных местах — локатор построит путь";
    $("tgoal").textContent = "";
  }
  drawRadar(P);
  const trend = altTrend(S.measures);
  $("trend").textContent = trend ? "⛰ " + trend : "";

  const top = P[0]?.speed || 1;
  $("places").innerHTML = P.slice(0, 20).map((p, i) => {
    const g = grade(p.speed);
    return `<li><span class="dot lv${g.level}"></span><span class="grow"><b>${i + 1}. ${sp(p.speed)}</b> · ${esc(p.label || "без метки")}<span class="dim">${here ? esc(hint(here, p)) + " · " : ""}замеров: ${p.count}</span><div class="minibar"><i style="width:${Math.max(4, (p.speed / top) * 100)}%"></i></div></span></li>`;
  }).join("") || `<li class="empty">Здесь появятся места, где вы сканировали</li>`;

  $("log").innerHTML = S.measures.map((m, i) => ({ m, i })).reverse().slice(0, 100).map(({ m, i }) => {
    const g = grade(m.mbps);
    const s = m.ok ? `${sp(m.mbps)} · ${m.ping} мс` : "нет связи";
    return `<li><span class="dot lv${m.ok ? g.level : 1}"></span><span class="grow">${when(m.time)} · <b>${s}</b>${m.label ? " · " + esc(m.label) : ""}${m.lat == null ? " · без места" : ""}</span><button class="x" data-del="${i}" title="Удалить">✕</button></li>`;
  }).join("") || `<li class="empty">Замеров пока нет</li>`;
  $("used").textContent = `ТРАФИК ${fmt(S.usedBytes / 1e6)} МБ`;
  $("eco").checked = !!S.eco;
  $("sound").checked = !!S.sound;
  if (mapObj) drawMap(P);
}

// ---------- Локатор: радар, вы в центре ----------
let path = [], lastNext = null, lastP = [];
const LV = { 4: "#2dff7a", 3: "#9be22d", 2: "#ffb020", 1: "#ff3b30" };
function niceScale(m) { for (const s of [25, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000, 50000]) if (m <= s) return s; return 100000; }
function drawRadar(P = lastP) {
  lastP = P;
  const svg = $("radar");
  const rot = heading == null ? 0 : -heading; // телефон смотрит вверх
  let maxD = 25;
  for (const q of path) maxD = Math.max(maxD, offset(here, q).d);
  const scale = niceScale(maxD * 1.1);
  const k = 100 / scale;
  $("scale").textContent = here ? `КРУГ = ${scale >= 1000 ? fmt(scale / 1000) + " км" : scale + " м"}` : "";
  const xy = (o) => { const f = Math.min(o.d * k, 104) / (o.d || 1); return [(o.x * f).toFixed(1), (o.y * f).toFixed(1)]; };
  let h = `<defs><linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2dff7a" stop-opacity=".22"/><stop offset="1" stop-color="#2dff7a" stop-opacity="0"/></linearGradient></defs>`;
  h += `<circle r="104" fill="#030805" stroke="#2a5a36" stroke-width="2"/>`;
  for (const r of [35, 70]) h += `<circle class="ring" r="${r}"/>`;
  h += `<g class="beamg"><path class="beam" d="M0 0 L104 0 A104 104 0 0 0 90 -52 Z"/></g>`;
  h += `<g transform="rotate(${rot})">`;
  h += `<line class="axis" x1="-104" y1="0" x2="104" y2="0"/><line class="axis" x1="0" y1="-104" x2="0" y2="104"/>`;
  h += `<text class="nn" x="0" y="-92" text-anchor="middle" transform="rotate(${-rot} 0 -96)">С</text>`;
  if (here) {
    for (const p of P) { const [x, y] = xy(offset(here, p)); h += `<circle cx="${x}" cy="${y}" r="4.5" fill="${LV[grade(p.speed).level]}"/>`; }
    for (const m of S.measures) if (!m.ok && m.lat != null) { const [x, y] = xy(offset(here, m)); h += `<text x="${x}" y="${Number(y) + 3}" fill="#ff3b30" font-size="9" text-anchor="middle">×</text>`; }
    if (path.length) {
      const line = [["0", "0"], ...path.map((q) => xy(offset(here, q)))];
      h += `<polyline class="path" points="${line.map((a) => a.join(",")).join(" ")}"/>`;
      const [nx, ny] = line[1]; h += `<circle class="next" cx="${nx}" cy="${ny}" r="9"/>`;
      const [gx, gy] = line.at(-1); h += `<circle class="goal" cx="${gx}" cy="${gy}" r="8"/><circle class="goal" cx="${gx}" cy="${gy}" r="3"/>`;
    }
  }
  h += `</g>`;
  h += here ? `<path class="me" d="M0 -9 L6 6 L0 3 L-6 6 Z"/>` : `<text class="rl" x="0" y="4" text-anchor="middle">НЕТ GPS</text>`;
  svg.innerHTML = h;
}
function updateArrow() { drawRadar(); }

// Компас телефона: стрелка показывает реальное направление к цели.
let compassOn = false;
function startCompass() {
  if (compassOn) return;
  compassOn = true;
  const onTurn = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h != null) { heading = h; updateArrow(); }
  };
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then((s) => { if (s === "granted") addEventListener("deviceorientation", onTurn); }).catch(() => {});
    } else if ("ondeviceorientationabsolute" in window) addEventListener("deviceorientationabsolute", onTurn);
    else addEventListener("deviceorientation", onTurn);
  } catch { /* компаса нет */ }
}

function when(t) {
  const d = new Date(t);
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return new Date().toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${hm}`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function toast(t) { const el = $("toast"); el.textContent = t; el.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add("hidden"), 3000); }

// ---------- Карта (по кнопке: карта тратит трафик) ----------
let mapObj = null, layer = null;
const COLORS = { 4: "#2dff7a", 3: "#9be22d", 2: "#ffb020", 1: "#ff3b30" };
async function openMap() {
  const box = $("map");
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  if (!window.L) {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "vendor/leaflet.css"; document.head.append(css);
    await new Promise((ok, fail) => { const s = document.createElement("script"); s.src = "vendor/leaflet.js"; s.onload = ok; s.onerror = fail; document.head.append(s); });
  }
  if (!mapObj) {
    mapObj = L.map(box);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, crossOrigin: "anonymous", attribution: "© OpenStreetMap" }).addTo(mapObj);
  }
  drawMap(places(S.measures));
}
function drawMap(P) {
  if (layer) layer.remove();
  layer = L.layerGroup().addTo(mapObj);
  for (const p of P) {
    L.circleMarker([p.lat, p.lon], { radius: 10, color: COLORS[grade(p.speed).level], fillOpacity: 0.8 })
      .bindPopup(`${sp(p.speed)}${p.label ? " · " + esc(p.label) : ""}`).addTo(layer);
  }
  // Мёртвые зоны: где связи не было совсем.
  for (const m of S.measures) {
    if (!m.ok && m.lat != null) L.circleMarker([m.lat, m.lon], { radius: 5, color: "#ff3b30", fillOpacity: 0.4, dashArray: "2 3" }).bindPopup(`нет связи${m.label ? " · " + esc(m.label) : ""}`).addTo(layer);
  }
  if (here) L.circleMarker([here.lat, here.lon], { radius: 6, color: "#ffffff", fillOpacity: 1 }).bindPopup("Вы здесь").addTo(layer);
  const pts = P.map((p) => [p.lat, p.lon]);
  if (here) pts.push([here.lat, here.lon]);
  if (pts.length) mapObj.fitBounds(pts, { maxZoom: 18, padding: [24, 24] });
  else mapObj.setView([56.95, 24.1], 7);
  setTimeout(() => mapObj.invalidateSize(), 50);
}

// ---------- Кнопки ----------
$("go").onclick = () => { audio()?.resume?.(); startCompass(); measure(); };
$("search").onchange = (e) => { audio()?.resume?.(); startCompass(); setSearch(e.target.checked); };
// Экран снова включили — браузер снимает запрет сна, просим заново.
document.addEventListener("visibilitychange", async () => { if (searching && document.visibilityState === "visible") { try { wake = await navigator.wakeLock?.request("screen"); } catch { /* ок */ } } });
$("sound").onchange = (e) => { S.sound = e.target.checked; save(); if (S.sound) { audio()?.resume?.(); click(); } };
$("eco").onchange = (e) => { S.eco = e.target.checked; save(); };
$("forest").onchange = (e) => { S.forest = e.target.checked; save(); applyForest(); toast(S.forest ? "ЛЕС: поиск раз в 15 с, малый трафик, без анимаций. Убавьте яркость экрана" : "ЛЕС выключен"); };
function applyForest() { document.body.classList.toggle("forest", !!S.forest); $("forest").checked = !!S.forest; }
applyForest();
// Заряд батареи (Android Chrome)
navigator.getBattery?.().then((b) => { const show = () => { $("bat").textContent = `🔋${Math.round(b.level * 100)}%`; $("bat").classList.toggle("low", b.level < 0.2 && !b.charging); if (b.level < 0.2 && !b.charging && !S.forest) toast("Батарея меньше 20% — включите режим ЛЕС"); }; show(); b.onlevelchange = show; }).catch(() => {});
$("showMap").onclick = () => openMap().catch(() => toast("Карта не загрузилась — нет интернета?"));
$("log").onclick = (e) => {
  const i = e.target.dataset?.del;
  if (i == null || !confirm("Удалить этот замер?")) return;
  S.measures.splice(Number(i), 1); save(); render();
};
$("clear").onclick = () => {
  if (!S.measures.length || !confirm(`Стереть все ${S.measures.length} замеров? Вернуть будет нельзя.`)) return;
  S.measures = []; S.usedBytes = 0; save(); render();
};
$("csv").onclick = () => {
  const blob = new Blob(["﻿" + toCSV(S.measures)], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `gde-lovit-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Пробный режим для проверки на ПК без GPS: ?demoGeo=широта,долгота[,курс]
const demoGeo = new URLSearchParams(location.search).get("demoGeo");
if (demoGeo) { const [la, lo, hd] = demoGeo.split(",").map(Number); here = { lat: la, lon: lo }; hereAcc = 5; if (Number.isFinite(hd)) heading = hd; }
// Текущее место — для цели и стрелки (обновляется при движении).
else if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (p) => { here = { lat: p.coords.latitude, lon: p.coords.longitude }; hereAcc = p.coords.accuracy; hereAlt = p.coords.altitude; $("ledGps").className = "led " + (p.coords.accuracy > 30 ? "warn" : "on"); render(); },
    () => { $("ledGps").className = "led off"; },
    { enableHighAccuracy: true, maximumAge: 10000 },
  );
}
$("net").textContent = netInfo().toUpperCase() || "NET";
setGauge(0);
$("val").textContent = "--.-";
const last = S.measures.at(-1);
if (last?.ok) { setGauge(last.mbps); $("word").textContent = grade(last.mbps).word.toUpperCase() + " (ПРОШЛЫЙ)"; $("ping").textContent = last.ping; }
render();
if (S.search) { $("search").checked = true; setSearch(true); }

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
