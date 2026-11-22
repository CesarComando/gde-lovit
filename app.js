// Окно «детектора»: прибор, скан, компас к лучшему месту, звук. Расчёты — в core.js.
import { altHint, altTrend, bearing, confidence, createGpsFilter, createStepDetector, huntPlan, linkOf, placeScore, distance, fixStatus, headingSpread, insError, moveBy, netClass, stepFromWalk, trackCSV, median, offset, plausible, route, exactBits, fmt, gaugePos, grade, hint, mbps, places, side, speedParts, toCSV } from "./core.js";

// Предохранитель: ответ засчитываем, только если он пришёл от сервера замера, а не от страницы входа Wi-Fi и т.п.
let portal = false;
function genuine(r) { const ok = r.ok && (r.headers.get("content-type") || "").includes("octet-stream"); if (!ok) portal = true; return ok; }

const sp = (v) => { const p = speedParts(v); return `${p.value} ${p.unit}`; };

const KEY = "gdeLovit.v1";
const TEST_URL = "https://speed.cloudflare.com/__down?bytes=";
const $ = (id) => document.getElementById(id);

// ---------- Хранилище (только в этом телефоне) ----------
function load() {
  const empty = { measures: [], usedBytes: 0, eco: false, sound: true, ins: true, stepCm: 70, track: [] };
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
  return times.length ? Math.round(median(times)) : null; // медиана — устойчиво к одиночным скачкам
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
function logEvent(mode, note) {
  S.track = S.track || [];
  S.track.push({ t: Date.now(), mode, lat: here?.lat, lon: here?.lon, acc: hereAcc, steps: insSteps, hdg: heading, spread, note });
  if (S.track.length > 5000) S.track.splice(0, S.track.length - 5000);
  save(); updTrackInfo?.();
}
function badMeasure() {
  logEvent("СКАН", "отбраковка: невозможный результат замера — не сохранён");
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
  // Три коротких замера подряд и медиана — кратковременный скачок нагрузки не испортит результат.
  const samples = [];
  if (p != null) {
    const weak = p > 800;
    const per = { maxBytes: S.eco ? 350_000 : 1_700_000, maxMs: weak ? 4000 : S.eco ? 1400 : 2000, quiet: true };
    for (let i = 0; i < 3; i++) {
      $("status").textContent = `ЗАМЕР ${i + 1} ИЗ 3…`;
      const d = await download(p, per);
      samples.push({ bytes: d.bytes, ms: Math.round(d.ms), mbps: d.bytes ? mbps(d.bytes, d.ms) : 0 });
    }
  }
  const d = { bytes: samples.reduce((s, x) => s + x.bytes, 0), ms: samples.reduce((s, x) => s + x.ms, 0) };
  const geo = await geoP;
  if (!searching) geigerStop();
  const speed = samples.length ? median(samples.map((x) => x.mbps)) : 0;
  const m = {
    time: Date.now(), mbps: speed, ping: p, ok: p != null, bytes: d.bytes, ms: Math.round(d.ms),
    samples: samples.map((x) => Math.round(x.mbps * 1000) / 1000), ins: insMode || undefined, link: curLink() || S.cmp,
    lat: geo?.lat ?? null, lon: geo?.lon ?? null, acc: geo?.acc ?? null, alt: geo?.alt ?? null,
    net: netInfo(), label: $("label").value.trim().slice(0, 40),
  };
  if (insMode && here) { m.lat = here.lat; m.lon = here.lon; m.acc = hereAcc; } // в ИНС место — по шагам
  else if (geo && geo.acc <= GOOD_GPS) here = { lat: geo.lat, lon: geo.lon };
  S.usedBytes += d.bytes;
  if (!plausible(m)) { badMeasure(); return; }
  S.measures.push(m);
  save();
  logEvent("СКАН", m.ok ? `замеры: ${(m.samples || []).map((x) => sp(x)).join(" / ")} → медиана ${sp(m.mbps)}, пинг ${m.ping} мс, сеть ${linkOf(m)}${portal ? "; был ответ не от сервера замера" : ""}` : `нет связи${portal ? " (ответил не сервер замера — Wi-Fi просит вход?)" : ""}`);
  showNow(m);
  render();
  if (!searching) document.querySelector(".gaugebox").classList.remove("scanning");
  $("go").classList.remove("busy");
  busy = false;
}

// Класс связи «≈2G/3G/4G/5G» — по нашей скорости и пингу. Настоящий тип сети браузер не видит.
function showGen(speed, ping) {
  const c = netClass(speed, ping);
  const el = $("gen");
  el.textContent = c ? "≈" + c : "";
  $("gennote").textContent = c ? `≈${c} — оценка по качеству связи (скорость и пинг), а не настоящий тип сети` : "";
  el.className = "gen" + (c === "2G" ? " g2" : c === "3G" ? " g3" : "");
}
function tag(speed, ping) { const c = netClass(speed, ping); return c ? `<span class="tag" title="Оценка по качеству связи, не настоящий тип сети">≈${c}</span>` : ""; }
// Через что идёт интернет: Wi-Fi или мобильная сеть (Android Chrome сообщает, iPhone — нет).
function curLink() { const t = navigator.connection?.type; return t === "wifi" || t === "ethernet" ? "wifi" : t === "cellular" ? "cell" : null; }
function linkType() {
  const t = navigator.connection?.type;
  return t === "wifi" ? "WI-FI" : t === "cellular" ? "МОБ." : t === "ethernet" ? "КАБЕЛЬ" : t === "none" ? "НЕТ" : "СЕТЬ";
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
      if (!plausible(raw)) { logEvent("ПОИСК", `отбраковка: невозможный замер (${sp(raw.mbps)}, ${raw.ms} мс)`); await sleep(1000); continue; }
      if (raw.ok) recent.push(raw.mbps); else recent.length = 0;
      if (recent.length > 3) recent.shift();
      const r = raw.ok ? { ...raw, mbps: median(recent) } : raw; // середина из последних 3 — без случайных скачков
      lastMbps = r.ok ? r.mbps : 0;
      const m = { time: Date.now(), ...r, lat: here?.lat ?? null, lon: here?.lon ?? null, acc: hereAcc, alt: hereAlt, ins: insMode || undefined, link: curLink() || S.cmp, net: netInfo(), label: $("label").value.trim().slice(0, 40) };
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
    showGen(0);
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
  showGen(m.mbps, m.ping);
  $("word").textContent = g.word.toUpperCase();
  $("ping").textContent = m.ping;
  $("ledNet").className = "led " + (g.level >= 3 ? "on" : "warn");
  $("ledGps").className = "led " + (m.lat == null ? "off" : m.acc > 30 ? "warn" : "on");
  const c = confidence(m.bytes, m.ms);
  m.conf = c.level;
  if (c.level <= 1) $("val").textContent = "≈" + $("val").textContent;
  $("exact").textContent = `ТОЧНО: ${exactBits(m.mbps)} бит/с · ${String(m.bytes).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} Б за ${(m.ms / 1000).toFixed(2).replace(".", ",")} с · ДОСТОВЕРНОСТЬ: ${c.word.toUpperCase()}` + (m.samples?.length > 1 ? ` · ЗАМЕРЫ: ${m.samples.map((x) => sp(x)).join(" / ")} → МЕДИАНА` : "");
  $("status").textContent = `Можно: ${g.can}. ` + (m.lat == null ? "Место не определено — разрешите геолокацию" : `Записано, место ±${Math.round(m.acc)} м`);
  if (!quiet) resultBeep(g.level);
}

// ---------- Цель и списки ----------
let here = null, hereAcc = null, hereAlt = null, heading = null;
function render() {
  const P = places(S.measures, 15, S.cmp);
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
    $("tnote").innerHTML = (insMode ? `<span class="insline">👣 ИНС: по шагам · ${insSteps} шаг. · место ±${hereAcc} м${compassBad ? " · направление неточное" : ""}</span><br>` : "") + esc((heading == null ? "Радар повёрнут севером вверх" : "Радар поворачивается вместе с телефоном") + (ah && d >= 8 ? ` · ${ah}` : ""));
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
  huntRender();
  drawRadar(P);
  const trend = altTrend(S.measures);
  $("trend").textContent = trend ? "⛰ " + trend : "";

  const top = P[0]?.speed || 1;
  $("places").innerHTML = P.slice(0, 20).map((p, i) => {
    const g = grade(p.speed);
    return `<li><span class="dot lv${g.level}"></span><span class="grow"><b>${i + 1}. ${sp(p.speed)}</b>${tag(p.speed, p.ping)} · ${esc(p.label || "без метки")}<span class="dim">${here ? esc(hint(here, p)) + " · " : ""}${p.stability}${p.ping != null ? ` · пинг ${Math.round(p.ping)} мс` : ""} · ${p.ins ? "ИНС" : "GPS"}${p.acc != null ? ` ±${Math.round(p.acc)} м` : ""} · ${fmt(p.bytes / 1e6)} МБ</span><div class="minibar"><i style="width:${Math.max(4, (p.speed / top) * 100)}%"></i></div></span></li>`;
  }).join("") || `<li class="empty">Здесь появятся места, где вы сканировали</li>`;

  $("log").innerHTML = S.measures.map((m, i) => ({ m, i })).reverse().slice(0, 100).map(({ m, i }) => {
    const g = grade(m.mbps);
    const s = m.ok ? `${sp(m.mbps)}${tag(m.mbps, m.ping)} · ${m.ping} мс` : "нет связи";
    return `<li><span class="dot lv${m.ok ? g.level : 1}"></span><span class="grow">${when(m.time)} · <b>${s}</b>${m.label ? " · " + esc(m.label) : ""}${m.lat == null ? " · без места" : ""}${m.ins ? " · ИНС" : ""}${m.samples?.length > 1 ? `<span class="dim"> (${m.samples.map((x) => sp(x)).join(" / ")})</span>` : ""}</span><button class="x" data-del="${i}" title="Удалить">✕</button></li>`;
  }).join("") || `<li class="empty">Замеров пока нет</li>`;
  $("used").textContent = `ТРАФИК ${fmt(S.usedBytes / 1e6)} МБ`;
  $("eco").checked = !!S.eco;
  $("sound").checked = !!S.sound;
  if (mapObj && view === "map") drawMap(P);
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
  if (here) for (const s of huntSpots) {
    const [x, y] = xy(offset(here, s));
    h += `<circle cx="${x}" cy="${y}" r="7" fill="${huntTodo.includes(s) ? "none" : "#39d0ff55"}" stroke="#39d0ff" stroke-width="1.5" stroke-dasharray="${huntTodo.includes(s) ? "3 3" : "0"}"/>`;
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
    if (h != null) onHeading(h);
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

// ---------- Карта (главный экран) ----------
let mapObj = null, layer = null, view = "map", mapFitted = false, tileOk = 0, tileErr = 0;
const COLORS = { 4: "#2dff7a", 3: "#9be22d", 2: "#ffb020", 1: "#ff3b30" };
function setView(v, remember = true) {
  view = v;
  if (remember) { S.view = v; save(); }
  $("map").classList.toggle("hidden", v !== "map");
  $("radar").classList.toggle("hidden", v !== "radar");
  $("viewMap").classList.toggle("on", v === "map");
  $("viewRadar").classList.toggle("on", v === "radar");
  if (v === "map") ensureMap(); else drawRadar();
}
function ensureMap() {
  if (!window.L) { setView("radar", false); return; }
  if (!mapObj) {
    mapObj = L.map($("map"), { zoomControl: false });
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, crossOrigin: "anonymous", attribution: "© OpenStreetMap" }).addTo(mapObj);
    tiles.on("tileload", () => { tileOk++; });
    tiles.on("tileerror", () => {
      tileErr++;
      if (tileErr >= 6 && tileOk === 0 && view === "map") { toast("Карта этого места не сохранена и нет интернета — показываю РАДАР"); setView("radar", false); }
    });
  }
  drawMap(places(S.measures, 15, S.cmp));
  setTimeout(() => mapObj.invalidateSize(), 60);
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
  // Путь к зоне от точки к точке
  if (here && path.length) {
    L.polyline([[here.lat, here.lon], ...path.map((q) => [q.lat, q.lon])], { color: "#2dff7a", weight: 3, dashArray: "6 6" }).addTo(layer);
    const nx = path[0], g = path.at(-1);
    L.circleMarker([nx.lat, nx.lon], { radius: 14, color: "#2dff7a", fill: false, weight: 2 }).bindPopup("Следующая точка").addTo(layer);
    L.circleMarker([g.lat, g.lon], { radius: 16, color: "#ffb020", fill: false, weight: 3 }).bindPopup("Цель").addTo(layer);
  }
  for (const s of huntSpots) {
    const todo = huntTodo.includes(s);
    L.circleMarker([s.lat, s.lon], { radius: 11, color: "#39d0ff", weight: 2, fill: !todo, fillOpacity: 0.25, dashArray: todo ? "4 4" : null })
      .bindPopup(todo ? `Проверь здесь (${s.dir}) — дойди и нажми СКАН` : `Проверено (${s.dir})`).addTo(layer);
  }
  if (here) {
    if (hereAcc) L.circle([here.lat, here.lon], { radius: hereAcc, color: insMode ? "#ffb020" : "#2dff7a", weight: 1, fillOpacity: 0.08 }).addTo(layer);
    L.circleMarker([here.lat, here.lon], { radius: 7, color: "#ffffff", fillColor: insMode ? "#ffb020" : "#2dff7a", fillOpacity: 1, weight: 3 }).bindPopup(insMode ? "Вы здесь (по шагам)" : "Вы здесь").addTo(layer);
  }
  // Подогнать вид один раз; дальше только держим себя в кадре — карта не прыгает от каждого шага.
  if (!mapFitted) {
    const pts = P.map((p) => [p.lat, p.lon]);
    if (here) pts.push([here.lat, here.lon]);
    if (pts.length) { mapObj.fitBounds(pts, { maxZoom: 18, padding: [30, 30] }); mapFitted = true; }
    else mapObj.setView([56.95, 24.1], 7);
  } else if (here && !mapObj.getBounds().pad(-0.15).contains([here.lat, here.lon])) mapObj.panTo([here.lat, here.lon]);
}

// ---------- ИНС: навигация по шагам, когда GPS слабый или пропал ----------
// GPS работает и без интернета (спутники), но в густом лесу и оврагах ошибается. Тогда считаем место сами:
// шаг (датчик ускорения) × длина шага по направлению телефона (гироскоп + компас). Хороший GPS — сразу уточняет.
let insMode = false, lastGoodFix = 0, lastGpsAcc = null, insMeters = 0, insSteps = 0, motionOn = false;
const stepFeed = createStepDetector();
const GOOD_GPS = 25; // м
const gpsFilter = createGpsFilter({ good: GOOD_GPS });
let insErrM = 0; // «взвешенные» метры по шагам: с плохим компасом считаются втрое
function setInsLed() { $("ledIns").className = "led " + (insMode ? "warn" : S.ins !== false ? "on" : ""); }
// GPS — по серии точек (createGpsFilter): одна плохая точка режим не переключает, одиночный выброс игнорируется,
// после потери GPS место уточняется по 2 согласованным точкам. Время и точность каждой точки — в журнале прогулки.
function onGps(p) {
  const acc = p.coords.accuracy;
  lastFixAt = Date.now();
  lastRawFix = { t: p.timestamp || Date.now(), acc };
  hereAlt = p.coords.altitude ?? hereAlt;
  const f = gpsFilter({ t: p.timestamp || Date.now(), lat: p.coords.latitude, lon: p.coords.longitude, acc });
  if (f.note && (searching || insMode || S.hunt)) logEvent("GPS", f.note);
  if (f.changed === "lost") logEvent("GPS", "GPS потерян: 3 плохие точки подряд — переход на шаги");
  if (f.changed === "back") logEvent("GPS", "GPS вернулся: 2 согласованные точки — место уточнено");
  if (f.good) {
    autoCalibrate(p, acc);
    if (insMode) { insMode = false; toast(f.changed === "back" ? "📡 GPS вернулся — место уточнено по 2 согласованным точкам" : "📡 GPS снова отвечает — место уточнено"); }
    here = f.pos; hereAcc = Math.round(f.acc); lastGoodFix = Date.now(); lastGpsAcc = f.acc; insMeters = 0; insErrM = 0;
  } else if (S.ins !== false && heading != null) {
    if (!insMode) { insMode = true; toast("👣 GPS слабый (±" + Math.round(acc) + " м) несколько раз подряд — веду по шагам"); }
    if (!here) { here = { lat: p.coords.latitude, lon: p.coords.longitude }; hereAcc = acc; }
  } else {
    here = { lat: p.coords.latitude, lon: p.coords.longitude }; hereAcc = acc; cal = null;
  }
  $("ledGps").className = "led " + (acc > 30 ? "warn" : "on");
  setInsLed(); render(); updFix();
}
// GPS молчит 15 с — тоже переходим на шаги.
setInterval(() => {
  if (S.ins !== false && here && heading != null && !insMode && lastGoodFix && Date.now() - lastGoodFix > 15000) {
    insMode = true; $("ledGps").className = "led off"; setInsLed(); toast("👣 GPS пропал — веду по шагам"); render();
  }
}, 3000);
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  if (!stepFeed(e.timeStamp || performance.now(), Math.hypot(a.x, a.y, a.z))) return;
  insSteps++;
  if (insMode && here && heading != null) {
    const m = (S.stepCm || 70) / 100;
    here = moveBy(here, m, heading);
    insMeters += m;
    insErrM += compassBad ? m * 3 : m; // плохой компас — направление неточное, погрешность растёт втрое быстрее
    hereAcc = insError(lastGpsAcc, insErrM);
    render(); updFix();
  }
}
function startMotion() {
  if (motionOn) return;
  motionOn = true;
  try {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      DeviceMotionEvent.requestPermission().then((s) => { if (s === "granted") addEventListener("devicemotion", onMotion); }).catch(() => {});
    } else addEventListener("devicemotion", onMotion);
  } catch { /* датчика нет */ }
}

// ---------- Точность крупно, компас, калибровка шага, журнал прогулки ----------
let lastFixAt = null, lastRawFix = null, lastMbps = null, hdgBuf = [], spread = 0, compassBad = false, cal = null, calBase = null, calTimer = null;
function onHeading(h) {
  heading = h;
  const now = Date.now();
  hdgBuf.push({ t: now, h });
  while (hdgBuf.length && now - hdgBuf[0].t > 2500) hdgBuf.shift();
  spread = headingSpread(hdgBuf.map((x) => x.h));
  const bad = spread > 20;
  if (bad !== compassBad) { compassBad = bad; updFix(); }
  $("compassInfo").textContent = `Курс ${Math.round(h)}° · разброс ±${spread}° — ${bad ? "⚠ НЕСТАБИЛЕН: направление по шагам будет неточным" : "стабилен"}`;
  updateArrow();
}
function updFix() {
  const el = $("fix");
  const age = lastFixAt ? (Date.now() - lastFixAt) / 1000 : null;
  el.textContent = fixStatus({ ins: insMode, acc: here ? hereAcc : null, ageSec: age, compassBad: compassBad && (insMode || S.ins !== false) });
  el.className = "fix" + (!here || (!insMode && age > 20) ? " bad" : insMode || compassBad ? " ins" : "");
  const stale = !insMode && age > 20;
  $("scIcon").textContent = !here ? "📍" : insMode ? "👣" : stale ? "⚠️" : "📡";
  $("scSub").textContent = !here ? "Разрешите геолокацию — без неё локатор не работает"
    : insMode ? `GPS временно нет — продолжаю вести по шагам · ${insSteps} шаг.${compassBad ? " · направление неточное" : ""}`
    : stale ? "GPS давно не отвечал — позиция устаревает"
    : (compassBad ? "Компас «гуляет». " : "") + "Заявленная точность GPS: с вероятностью ~68% вы внутри этого круга";
  $("scBadge").textContent = insMode ? "ИНС ВКЛ" : !here ? "НЕТ GPS" : stale ? "GPS ?" : "GPS";
  $("statusCard").className = "panel statuscard" + (insMode ? " ins" : !here || stale ? " bad" : "");
}
setInterval(updFix, 1000);

// Автокалибровка: пока GPS хороший (±15 м) и мы не в ИНС, копим путь по GPS и шаги; каждые 30 м уточняем длину шага.
function autoCalibrate(p, acc) {
  if (acc > 15 || insMode || !motionOn) { cal = null; return; }
  const pos = { lat: p.coords.latitude, lon: p.coords.longitude };
  if (!cal) { cal = { last: pos, m: 0, steps: insSteps }; return; }
  const d = distance(cal.last, pos);
  if (d >= 3) { cal.m += d; cal.last = pos; } // меньше 3 м — дрожание GPS, не шаги
  if (cal.m >= 30) {
    const cm = stepFromWalk(cal.m, insSteps - cal.steps);
    if (cm && !S.stepManual) {
      S.stepCm = S.stepAuto ? Math.round(S.stepCm * 0.7 + cm * 0.3) : cm;
      S.stepAuto = true; save(); updStepInfo();
    }
    cal = { last: pos, m: 0, steps: insSteps };
  }
}
function updStepInfo() {
  $("stepcm").value = S.stepCm || 70;
  $("stepinfo").textContent = S.stepManual ? "Задано вручную." : S.stepAuto ? "Подобрано автоматически по GPS ✓" : "Пока стандартные 70 см — подберутся сами на первой прогулке с хорошим GPS.";
}
$("calStart").onclick = () => {
  startMotion(); startCompass();
  calBase = insSteps; $("calSteps").textContent = "0"; $("calM").value = "";
  $("calBox").classList.remove("hidden");
  clearInterval(calTimer); calTimer = setInterval(() => { $("calSteps").textContent = insSteps - calBase; }, 300);
  toast("Идите обычным шагом, потом впишите, сколько метров прошли");
};
$("calCancel").onclick = () => { clearInterval(calTimer); $("calBox").classList.add("hidden"); };
$("calSave").onclick = () => {
  const steps = insSteps - calBase, m = Number(String($("calM").value).replace(",", "."));
  const cm = stepFromWalk(m, steps);
  if (!cm) { toast(steps < 20 ? "Нужно хотя бы 20 шагов" : "Странный результат — проверьте метры"); return; }
  S.stepCm = cm; S.stepManual = true; S.stepAuto = false; save(); updStepInfo();
  clearInterval(calTimer); $("calBox").classList.add("hidden");
  toast(`Длина шага: ${cm} см (${steps} шагов на ${m} м)`);
};

// Журнал прогулки: каждые 5 с при ПОИСКЕ или ИНС.
setInterval(() => {
  if (!(searching || insMode)) return;
  S.track = S.track || [];
  S.track.push({ t: Date.now(), mode: insMode ? "ИНС" : here ? "GPS" : "нет", lat: here?.lat, lon: here?.lon, acc: hereAcc, steps: insSteps, hdg: heading, spread, stepCm: S.stepCm, mbps: lastMbps, gpsT: lastRawFix?.t, gpsAcc: lastRawFix?.acc });
  if (S.track.length > 5000) S.track.splice(0, S.track.length - 5000);
  save(); updTrackInfo();
}, 5000);
function updTrackInfo() { const n = (S.track || []).length; $("trackInfo").textContent = n ? `Записей: ${n} (~${Math.round((n * 5) / 60)} мин)` : "Пока пусто."; }
$("trackCsv").onclick = () => {
  if (!(S.track || []).length) { toast("Журнал прогулки пуст — включите ПОИСК или ИНС и пройдитесь"); return; }
  const blob = new Blob(["\ufeff" + trackCSV(S.track, { hideStartM: $("hideHome").checked ? 200 : 0 })], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `gde-lovit-progulka-${new Date().toISOString().slice(0, 16).replace(":", "-")}.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("trackClear").onclick = () => { if (confirm("Очистить журнал прогулки?")) { S.track = []; save(); updTrackInfo(); } };

// ---------- Первый запуск ----------
const INTRO = [
  { t: "РАЗРЕШЕНИЯ", p: "Прибору нужны местоположение (GPS) и датчики движения с компасом — для локатора и счёта шагов. Нажмите РАЗРЕШИТЬ и подтвердите в окнах телефона. Замеры остаются только в этом телефоне.", b: "РАЗРЕШИТЬ" },
  { t: "КАК ДЕРЖАТЬ", p: "Держите телефон перед собой, верхом по ходу движения — так компас и шаги считаются правильно. Экран не гасите: с погашенным экраном браузер останавливает поиск. Для экономии убавьте яркость и включите ЛЕС 🔋.", b: "ПОНЯТНО" },
  { t: "ПРОБНЫЙ МАРШРУТ", p: "Включим ПОИСК и ИНС. Пройдите метров 50 по прямой, где хороший GPS, — длина шага подстроится сама. После прогулки в ⚙ Настройки скачайте журнал прогулки и пришлите, если что-то пошло не так.", b: "НАЧАТЬ" },
];
let introI = 0;
function showIntro(i) {
  introI = i;
  $("introStep").textContent = `ШАГ ${i + 1} ИЗ ${INTRO.length}`;
  $("introTitle").textContent = INTRO[i].t;
  $("introText").textContent = INTRO[i].p;
  $("introNext").textContent = INTRO[i].b;
  $("intro").classList.remove("hidden");
}
function closeIntro() { $("intro").classList.add("hidden"); S.introDone = true; save(); }
$("introSkip").onclick = closeIntro;
$("introAgain").onclick = () => showIntro(0);
$("introNext").onclick = () => {
  if (introI === 0) {
    audio()?.resume?.(); startCompass(); startMotion();
    navigator.geolocation?.getCurrentPosition(() => {}, () => toast("Без доступа к месту локатор работать не будет"), { enableHighAccuracy: true, timeout: 15000 });
  }
  if (introI === INTRO.length - 1) {
    closeIntro();
    S.ins = true; $("ins").checked = true; save();
    if (!searching) { $("search").checked = true; setSearch(true); }
    return;
  }
  showIntro(introI + 1);
};

// ---------- Кнопки ----------
$("go").onclick = () => { audio()?.resume?.(); startCompass(); startMotion(); measure(); };
$("search").onchange = (e) => { audio()?.resume?.(); startCompass(); startMotion(); setSearch(e.target.checked); };
$("ins").onchange = (e) => { S.ins = e.target.checked; save(); startCompass(); startMotion(); if (!S.ins && insMode) { insMode = false; setInsLed(); } toast(S.ins ? "ИНС включена: если GPS ослабнет, поведу по шагам. Держите телефон перед собой" : "ИНС выключена"); };
$("stepcm").onchange = (e) => { const v = Math.round(Number(e.target.value)); if (v >= 40 && v <= 120) { S.stepCm = v; S.stepManual = true; S.stepAuto = false; save(); updStepInfo(); } else { e.target.value = S.stepCm; toast("Длина шага: от 40 до 120 см"); } };
$("ins").checked = S.ins !== false;
$("stepcm").value = S.stepCm || 70;
// Экран снова включили — браузер снимает запрет сна, просим заново.
let hiddenAt = null;
document.addEventListener("visibilitychange", async () => {
  const active = searching || insMode || S.hunt;
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    if (active) logEvent("ПАУЗА", "экран погас или приложение свёрнуто — трек приостановлен (браузер останавливает таймеры)");
  } else {
    if (active && hiddenAt) logEvent("ПРОДОЛЖЕНО", `трек возобновлён, пауза ${Math.round((Date.now() - hiddenAt) / 1000)} с`);
    hiddenAt = null;
    if (searching) { try { wake = await navigator.wakeLock?.request("screen"); wake?.addEventListener?.("release", () => { if (searching && document.visibilityState === "visible") logEvent("ПАУЗА?", "браузер снял запрет сна экрана"); }); } catch { /* ок */ } }
  }
});
$("sound").onchange = (e) => { S.sound = e.target.checked; save(); if (S.sound) { audio()?.resume?.(); click(); } };
$("eco").onchange = (e) => { S.eco = e.target.checked; save(); };
$("forest").onchange = (e) => { S.forest = e.target.checked; save(); applyForest(); toast(S.forest ? "ЛЕС: поиск раз в 15 с, малый трафик, без анимаций. Убавьте яркость экрана" : "ЛЕС выключен"); };
function applyForest() { document.body.classList.toggle("forest", !!S.forest); $("forest").checked = !!S.forest; }
applyForest();
// Заряд батареи (Android Chrome)
navigator.getBattery?.().then((b) => { const show = () => { $("bat").textContent = `🔋${Math.round(b.level * 100)}%`; $("bat").classList.toggle("low", b.level < 0.2 && !b.charging); if (b.level < 0.2 && !b.charging && !S.forest) toast("Батарея меньше 20% — включите режим ЛЕС"); }; show(); b.onlevelchange = show; }).catch(() => {});
function showTab(t) {
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("hidden", s.dataset.tab !== t));
  document.querySelectorAll(".tb").forEach((b) => b.classList.toggle("on", b.dataset.go === t));
  S.tab = t; save();
  if (t === "map" && view === "map") setTimeout(() => mapObj?.invalidateSize(), 60);
  scrollTo(0, 0);
}
document.querySelectorAll(".tb").forEach((b) => { b.onclick = () => showTab(b.dataset.go); });
$("viewMap").onclick = () => setView("map");
// ---------- Сравнение: мобильная сеть / Wi-Fi ----------
function setCmp(c, why = "") {
  S.cmp = c; save();
  document.querySelectorAll(".cmpb").forEach((b) => b.classList.toggle("on", b.dataset.cmp === c));
  const known = curLink();
  $("cmpNote").textContent = known ? `Сейчас интернет через ${known === "wifi" ? "Wi-Fi" : "мобильную сеть"} — замеры помечаются сами` : "Телефон не сообщает тип сети (iPhone) — выберите, через что сейчас интернет: так будут помечены замеры";
  mapFitted = false; render();
  if (why) toast(why);
}
document.querySelectorAll(".cmpb").forEach((b) => { b.onclick = () => setCmp(b.dataset.cmp, b.dataset.cmp === "wifi" ? "Сравниваю места только по Wi-Fi" : "Сравниваю места только по мобильной сети"); });
navigator.connection?.addEventListener?.("change", () => { const l = curLink(); if (l && l !== S.cmp) setCmp(l, l === "wifi" ? "Интернет теперь через Wi-Fi — сравниваю Wi-Fi" : "Интернет теперь через мобильную сеть — сравниваю её"); });

// ---------- ПОИСК ЛУЧШЕЙ ТОЧКИ («горячо — холодно») ----------
let huntSpots = [], huntTodo = [], lastHuntKey = null;
function huntRender() {
  huntSpots = []; huntTodo = [];
  $("hunt").classList.toggle("on", !!S.hunt);
  $("hunt").textContent = S.hunt ? "■ ОСТАНОВИТЬ ПОИСК ТОЧКИ" : "🎯 ПОИСК ЛУЧШЕЙ ТОЧКИ";
  if (!S.hunt) return;
  let plan = huntPlan(S.hunt, S.measures, S.cmp);
  for (let i = 0; plan.next && i < 5; i++) { S.hunt = plan.next; save(); toast(`🎯 Круг ${S.hunt.round}: ${S.hunt.r < 15 ? "сужаю поиск" : "сдвигаю центр туда, где лучше"}`); plan = huntPlan(S.hunt, S.measures, S.cmp); }
  if (plan.done) {
    S.hunt = null; save();
    $("hunt").classList.remove("on"); $("hunt").textContent = "🎯 ПОИСК ЛУЧШЕЙ ТОЧКИ";
    toast(`🎯 Лучшая точка найдена: оценка ${plan.best.score} из 100 — локатор ведёт к ней`);
    logEvent("ТОЧКА", `поиск лучшей точки завершён: оценка ${plan.best.score}`);
    if (S.sound) [0, 1, 2].forEach((i) => setTimeout(() => click(900 + i * 300, 0.12, 0.35), i * 160));
    return;
  }
  huntSpots = plan.spots; huntTodo = plan.todo;
  if (!here || !huntTodo.length) return;
  const t = huntTodo.reduce((a, b) => (distance(here, b) < distance(here, a) ? b : a));
  const d = distance(here, t);
  path = [t];
  $("tdist").textContent = d < 6 ? "ВЫ НА ТОЧКЕ → СКАН" : `ПРОВЕРЬ: ${Math.round(d)} м → ${side(bearing(here, t)).toUpperCase()}`;
  $("tinfo").innerHTML = `<span class="huntline">🎯 ПОИСК ЛУЧШЕЙ ТОЧКИ · круг ${S.hunt.round} · осталось проверить ${huntTodo.length} из 5</span>`;
  $("tnote").textContent = `Точки вокруг центра на ${Math.round(S.hunt.r)} м: ${t.dir === "центр" ? "центр" : "на " + t.dir}. Дойдите и нажмите СКАН.`;
  $("tgoal").textContent = "";
  const key = `${t.lat.toFixed(5)}${d < 6}`;
  if (d < 6 && lastHuntKey !== key) { if (S.sound) click(1400, 0.1, 0.35); try { navigator.vibrate?.([80, 60, 80]); } catch { /* нет */ } }
  lastHuntKey = key;
}
$("hunt").onclick = () => {
  audio()?.resume?.(); startCompass(); startMotion();
  if (S.hunt) { S.hunt = null; save(); render(); toast("Поиск точки остановлен"); return; }
  if (!here) { toast("Нужно место: разрешите геолокацию и подождите GPS"); return; }
  S.hunt = { center: { ...here }, r: 15, round: 1, since: Date.now() }; save();
  toast("🎯 Начинаю здесь: замер в центре, потом 4 точки вокруг на 15 м");
  logEvent("ТОЧКА", `поиск лучшей точки начат, сеть ${S.cmp === "wifi" ? "Wi-Fi" : "мобильная"}`);
  render(); measure();
};
$("viewRadar").onclick = () => setView("radar");
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
if (demoGeo) { const [la, lo, hd] = demoGeo.split(",").map(Number); here = { lat: la, lon: lo }; hereAcc = 5; lastFixAt = Date.now(); setInterval(() => { lastFixAt = Date.now(); }, 1000); if (Number.isFinite(hd)) heading = hd; }
// Текущее место — для цели и стрелки (обновляется при движении).
else if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    onGps,
    () => { $("ledGps").className = "led off"; },
    { enableHighAccuracy: true, maximumAge: 10000 },
  );
}
$("net").textContent = linkType();
navigator.connection?.addEventListener?.("change", () => { $("net").textContent = linkType(); });
setInsLed();
setGauge(0);
$("val").textContent = "--.-";
const last = S.measures.at(-1);
if (last?.ok) { setGauge(last.mbps); showGen(last.mbps, last.ping); $("word").textContent = grade(last.mbps).word.toUpperCase() + " (ПРОШЛЫЙ)"; $("ping").textContent = last.ping; }
render();
showTab(S.tab || "map");
setCmp(curLink() || S.cmp || "cell");
setView(S.view || "map", false);
updStepInfo(); updTrackInfo(); updFix();
if (!S.introDone) showIntro(0);
if (S.search) { $("search").checked = true; setSearch(true); }

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
