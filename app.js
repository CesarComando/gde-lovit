// Окно «детектора»: прибор, скан, компас к лучшему месту, звук. Расчёты — в core.js.
import { bearing, distance, exactBits, fmt, gaugePos, grade, hint, mbps, places, side, speedParts, toCSV } from "./core.js";

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
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
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
      times.push(performance.now() - t);
    } catch { if (!times.length) break; }
  }
  return times.length ? Math.round(Math.min(...times)) : null;
}

// Загрузка: при слабой связи (долгий пинг) даём больше времени, чтобы поймать хоть какие-то биты.
async function download(pingMs) {
  const weak = pingMs > 800;
  const maxBytes = S.eco ? 1_000_000 : 5_000_000;
  const maxMs = weak ? 12000 : S.eco ? 4000 : 6000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  const t0 = performance.now();
  let got = 0;
  try {
    const r = await fetch(TEST_URL + maxBytes + "&r=" + Math.random(), { cache: "no-store", signal: ctrl.signal });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      const el = performance.now() - t0;
      if (el > 300) setGauge(mbps(got, el), true);
      $("status").textContent = `СКАНИРУЮ… ${Math.round(got / 1024)} КБ`;
    }
  } catch { /* остановили по времени — считаем то, что успело скачаться */ }
  clearTimeout(timer);
  return { bytes: got, ms: performance.now() - t0 };
}

let busy = false;
async function measure() {
  if (busy) return;
  busy = true;
  $("go").classList.add("busy");
  document.querySelector(".gaugebox").classList.add("scanning");
  $("word").textContent = "СКАН";
  $("status").textContent = "ИЩУ МЕСТО И СВЯЗЬ…";
  setGauge(0, true);
  geigerStart();
  const geoP = where();
  const p = await ping();
  $("ping").textContent = p ?? "---";
  const d = p == null ? { bytes: 0, ms: 0 } : await download(p);
  const geo = await geoP;
  geigerStop();
  const speed = d.bytes > 0 ? mbps(d.bytes, d.ms) : 0;
  const m = {
    time: Date.now(), mbps: speed, ping: p, ok: p != null, bytes: d.bytes, ms: Math.round(d.ms),
    lat: geo?.lat ?? null, lon: geo?.lon ?? null, acc: geo?.acc ?? null,
    net: netInfo(), label: $("label").value.trim().slice(0, 40),
  };
  if (geo) here = { lat: geo.lat, lon: geo.lon };
  S.usedBytes += d.bytes;
  S.measures.push(m);
  save();
  showNow(m);
  render();
  document.querySelector(".gaugebox").classList.remove("scanning");
  $("go").classList.remove("busy");
  busy = false;
}

function netInfo() {
  const c = navigator.connection;
  return c ? [c.type, c.effectiveType].filter(Boolean).join(" ") : "";
}

function showNow(m) {
  if (!m.ok) {
    setGauge(0);
    $("word").textContent = "НЕТ СВЯЗИ";
    $("exact").textContent = "ТОЧНО: 0 бит/с · сервер не ответил за 12 с";
    $("status").textContent = "Попробуйте выше или на открытом месте. Экстренно: 112 — работает через любого оператора";
    $("ledNet").className = "led off";
    resultBeep(1);
    return;
  }
  const g = grade(m.mbps);
  setGauge(m.mbps);
  $("word").textContent = g.word.toUpperCase();
  $("ping").textContent = m.ping;
  $("ledNet").className = "led " + (g.level >= 3 ? "on" : "warn");
  $("ledGps").className = "led " + (m.lat == null ? "off" : m.acc > 30 ? "warn" : "on");
  $("exact").textContent = `ТОЧНО: ${exactBits(m.mbps)} бит/с · ${String(m.bytes).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} Б за ${(m.ms / 1000).toFixed(2).replace(".", ",")} с`;
  $("status").textContent = `Можно: ${g.can}. ` + (m.lat == null ? "Место не определено — разрешите геолокацию" : `Записано, место ±${Math.round(m.acc)} м`);
  resultBeep(g.level);
}

// ---------- Цель и списки ----------
let here = null, heading = null;
function render() {
  const P = places(S.measures);
  const b = P[0];
  if (b) {
    const g = grade(b.speed);
    $("tinfo").innerHTML = `<span class="dot lv${g.level}" style="display:inline-block"></span> <b>${sp(b.speed)}</b> · ${esc(b.label || "без метки")}`;
    if (here) {
      const d = distance(here, b);
      $("tdist").textContent = d < 8 ? "ВЫ ЗДЕСЬ" : d < 1000 ? `${Math.round(d)} м` : `${fmt(d / 1000)} км`;
      $("tnote").textContent = d < 8 ? "Лучшее место — прямо тут" : `на ${side(bearing(here, b))}${heading == null ? " · стрелка относительно севера" : " · стрелка по компасу"}`;
    } else {
      $("tdist").textContent = "—";
      $("tnote").textContent = "Нажмите СКАН, чтобы узнать, куда идти";
    }
  } else {
    $("tdist").textContent = "—";
    $("tinfo").textContent = "Нет замеров с местоположением";
    $("tnote").textContent = "";
  }
  updateArrow();

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

function updateArrow() {
  const P = places(S.measures);
  const a = $("arrow");
  if (!here || !P[0] || distance(here, P[0]) < 8) { a.classList.add("none"); a.textContent = P[0] && here ? "◉" : "▲"; a.style.transform = ""; return; }
  a.classList.remove("none"); a.textContent = "▲";
  const deg = bearing(here, P[0]) - (heading ?? 0);
  a.style.transform = `rotate(${deg}deg)`;
}

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
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapObj);
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

// ---------- Обход: скан каждые 30 с ----------
let autoTimer = null, wake = null;
async function setAuto(on) {
  clearInterval(autoTimer);
  if (on) {
    measure();
    autoTimer = setInterval(measure, 30000);
    try { wake = await navigator.wakeLock?.request("screen"); } catch { /* не поддерживается */ }
    toast("ОБХОД: ходите по местам, детектор сканирует сам");
  } else {
    try { await wake?.release(); } catch { /* ок */ }
    wake = null;
  }
}

// ---------- Кнопки ----------
$("go").onclick = () => { audio()?.resume?.(); startCompass(); measure(); };
$("auto").onchange = (e) => { audio()?.resume?.(); startCompass(); setAuto(e.target.checked); };
$("sound").onchange = (e) => { S.sound = e.target.checked; save(); if (S.sound) { audio()?.resume?.(); click(); } };
$("eco").onchange = (e) => { S.eco = e.target.checked; save(); };
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

// Текущее место — для цели и стрелки (обновляется при движении).
if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (p) => { here = { lat: p.coords.latitude, lon: p.coords.longitude }; $("ledGps").className = "led " + (p.coords.accuracy > 30 ? "warn" : "on"); render(); },
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

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
