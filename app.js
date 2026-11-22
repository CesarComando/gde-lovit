// Окно приложения: кнопки, замер, список. Расчёты — в core.js.
import { fmt, grade, hint, mbps, places, toCSV } from "./core.js";

const KEY = "gdeLovit.v1";
const TEST_URL = "https://speed.cloudflare.com/__down?bytes=";
const $ = (id) => document.getElementById(id);

// ---------- Хранилище (только в этом телефоне) ----------
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { measures: [], usedBytes: 0, eco: false }; }
  catch { return { measures: [], usedBytes: 0, eco: false }; }
}
let S = load();
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast("Не удалось сохранить в памяти телефона"); } }

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

async function ping() {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    try {
      const r = await fetch(TEST_URL + "0&r=" + Math.random(), { cache: "no-store", signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer();
      times.push(performance.now() - t);
    } catch { /* нет связи */ }
  }
  return times.length ? Math.round(Math.min(...times)) : null;
}

async function download() {
  const maxBytes = S.eco ? 1_000_000 : 5_000_000;
  const maxMs = S.eco ? 4000 : 6000;
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
      $("nowText").textContent = `Меряю скорость… ${Math.round(got / 1024)} КБ`;
    }
  } catch { /* остановили по времени — считаем то, что успело скачаться */ }
  clearTimeout(timer);
  const ms = performance.now() - t0;
  return { bytes: got, ms };
}

let busy = false;
async function measure() {
  if (busy) return;
  busy = true;
  $("go").disabled = true;
  $("nowSpeed").textContent = "…";
  $("nowText").textContent = "Определяю место и связь…";
  const geoP = where();
  const p = await ping();
  const d = p == null ? { bytes: 0, ms: 0 } : await download();
  const geo = await geoP;
  const speed = d.bytes > 0 ? mbps(d.bytes, d.ms) : 0;
  const m = {
    time: Date.now(),
    mbps: speed,
    ping: p,
    ok: p != null,
    lat: geo?.lat ?? null,
    lon: geo?.lon ?? null,
    acc: geo?.acc ?? null,
    net: netInfo(),
    label: $("label").value.trim().slice(0, 40),
  };
  if (geo) here = { lat: geo.lat, lon: geo.lon };
  S.usedBytes += d.bytes;
  S.measures.push(m);
  save();
  showNow(m);
  render();
  busy = false;
  $("go").disabled = false;
}

function netInfo() {
  const c = navigator.connection;
  if (!c) return "";
  return [c.type, c.effectiveType].filter(Boolean).join(" ");
}

// ---------- Экран ----------
function showNow(m) {
  if (!m.ok) {
    $("nowSpeed").textContent = "нет связи";
    $("nowText").textContent = "Интернет здесь не отвечает";
    return;
  }
  const g = grade(m.mbps);
  $("nowSpeed").innerHTML = `${fmt(m.mbps)} <small>Мбит/с</small>`;
  const geo = m.lat == null ? " · место не определено (разрешите доступ к геолокации)" : ` · точность места ±${Math.round(m.acc)} м`;
  $("nowText").textContent = `${g.word} · пинг ${m.ping} мс${geo}`;
}

let here = null;
function render() {
  const P = places(S.measures);
  // Лучшее место
  $("best").classList.toggle("muted", !P.length);
  if (P.length) {
    const b = P[0];
    const g = grade(b.speed);
    $("best").innerHTML = `<div><span class="dot lv${g.level}" style="display:inline-block"></span> <b>${fmt(b.speed)} Мбит/с</b> · ${g.word}</div>
      <div class="muted">${esc(b.label || "без метки")} · замеров: ${b.count} · ${when(b.last)}</div>
      <div class="go">${here ? esc(hint(here, b)) : "Нажмите «Замерить», чтобы узнать, куда идти"}</div>`;
  } else {
    $("best").textContent = "Пока нет замеров с местоположением.";
  }
  // Места
  $("places").innerHTML = P.slice(0, 20).map((p, i) => {
    const g = grade(p.speed);
    return `<li><span class="dot lv${g.level}"></span><span class="grow"><b>${i + 1}. ${fmt(p.speed)} Мбит/с</b> · ${esc(p.label || "без метки")}<br><span class="muted">${here ? esc(hint(here, p)) + " · " : ""}замеров: ${p.count}</span></span></li>`;
  }).join("") || `<li class="muted">Здесь появятся места, где вы мерили связь.</li>`;
  // Все замеры, новые сверху
  $("log").innerHTML = S.measures.map((m, i) => ({ m, i })).reverse().slice(0, 100).map(({ m, i }) => {
    const g = grade(m.mbps);
    const s = m.ok ? `${fmt(m.mbps)} Мбит/с · ${m.ping} мс` : "нет связи";
    return `<li><span class="dot lv${m.ok ? g.level : 1}"></span><span class="grow">${when(m.time)} · <b>${s}</b>${m.label ? " · " + esc(m.label) : ""}${m.lat == null ? " · без места" : ""}</span><button class="x" data-del="${i}" title="Удалить">✕</button></li>`;
  }).join("") || `<li class="muted">Замеров пока нет.</li>`;
  $("used").textContent = `трафик на замеры: ${fmt(S.usedBytes / 1e6)} МБ`;
  $("eco").checked = !!S.eco;
  if (mapObj) drawMap(P);
}

function when(t) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return today ? `сегодня ${hm}` : `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${hm}`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function toast(t) { const el = $("toast"); el.textContent = t; el.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add("hidden"), 3000); }

// ---------- Карта (по кнопке: карта тратит трафик) ----------
let mapObj = null, layer = null;
const COLORS = { 4: "#16a34a", 3: "#65a30d", 2: "#d97706", 1: "#dc2626" };
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
      .bindPopup(`${fmt(p.speed)} Мбит/с${p.label ? " · " + esc(p.label) : ""}`).addTo(layer);
  }
  if (here) L.circleMarker([here.lat, here.lon], { radius: 6, color: "#2563eb", fillOpacity: 1 }).bindPopup("Вы здесь").addTo(layer);
  const pts = P.map((p) => [p.lat, p.lon]);
  if (here) pts.push([here.lat, here.lon]);
  if (pts.length) mapObj.fitBounds(pts, { maxZoom: 18, padding: [24, 24] });
  else mapObj.setView([56.95, 24.1], 7);
  setTimeout(() => mapObj.invalidateSize(), 50);
}

// ---------- Обход: замер каждые 30 с ----------
let autoTimer = null, wake = null;
async function setAuto(on) {
  clearInterval(autoTimer);
  if (on) {
    measure();
    autoTimer = setInterval(measure, 30000);
    try { wake = await navigator.wakeLock?.request("screen"); } catch { /* не поддерживается */ }
    toast("Обход включён: ходите по местам, телефон мерит сам");
  } else {
    try { await wake?.release(); } catch { /* ок */ }
    wake = null;
  }
}

// ---------- Кнопки ----------
$("go").onclick = () => measure();
$("auto").onchange = (e) => setAuto(e.target.checked);
$("showMap").onclick = () => openMap().catch(() => toast("Карта не загрузилась — нет интернета?"));
$("eco").onchange = (e) => { S.eco = e.target.checked; save(); };
$("log").onclick = (e) => {
  const i = e.target.dataset?.del;
  if (i == null) return;
  if (!confirm("Удалить этот замер?")) return;
  S.measures.splice(Number(i), 1); save(); render();
};
$("clear").onclick = () => {
  if (!S.measures.length) return;
  if (!confirm(`Удалить все ${S.measures.length} замеров? Вернуть будет нельзя.`)) return;
  S.measures = []; S.usedBytes = 0; save(); render();
};
$("csv").onclick = () => {
  const blob = new Blob(["﻿" + toCSV(S.measures)], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `gde-lovit-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Текущее место — для подсказки «куда идти» (обновляется при движении).
if (navigator.geolocation) {
  navigator.geolocation.watchPosition((p) => { here = { lat: p.coords.latitude, lon: p.coords.longitude }; render(); }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
}
$("net").textContent = netInfo();
render();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
