// «Сердце» приложения: расчёты без окна и без браузера.
// Здесь только чистые функции — их проверяют тесты (tests/core.test.js).

const R = 6371000; // радиус Земли, м
const rad = (d) => (d * Math.PI) / 180;

/** Расстояние между двумя точками {lat, lon} в метрах. */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Направление из a в b, градусы от севера по часовой (0..360). */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const SIDES = ["север", "северо-восток", "восток", "юго-восток", "юг", "юго-запад", "запад", "северо-запад"];
/** Сторона света словами. */
export function side(deg) {
  return SIDES[Math.round(deg / 45) % 8];
}

/** Скорость в мегабитах в секунду. */
export function mbps(bytes, ms) {
  if (!ms || ms <= 0) return 0;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

// ---------- Предохранители: не выдавать «абы какие» числа ----------

/** Насколько можно верить замеру: зависит от того, сколько данных и как долго мерили. */
export function confidence(bytes, ms) {
  if (!bytes || !ms) return { level: 0, word: "нет данных" };
  if (ms < 800) return { level: 1, word: "низкая" }; // слишком короткий замер
  if (bytes >= 500_000 && ms >= 1500) return { level: 3, word: "высокая" };
  if (bytes >= 30_000 || ms >= 5000) return { level: 2, word: "средняя" };
  return { level: 1, word: "низкая" };
}

/** Отсеять физически невозможные замеры (сбой браузера, часов, сети). */
export function plausible(m) {
  if (!m.ok) return true;
  if (!(m.mbps >= 0) || m.mbps > 3000) return false; // больше 3 Гбит/с телефон не принимает
  if (m.bytes > 0 && m.ms != null && m.ms < 100) return false; // «скачал» за миг — ошибка таймера
  if (m.ping != null && (m.ping < 1 || m.ping > 60000)) return false;
  return true;
}

/** Середина ряда — устойчива к одиночным скачкам. */
export function median(xs) {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const k = Math.floor(a.length / 2);
  return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
}

/** Точка с плохим GPS (погрешность больше 50 м) не годится для поиска лучшего места. */
export const GPS_MAX_ERR = 50;

/** Оценка словами, цветом и что можно делать при такой связи. */
export function grade(speed) {
  if (speed >= 10) return { word: "отлично", level: 4, can: "видео, звонки по видео" };
  if (speed >= 3) return { word: "нормально", level: 3, can: "звонки в мессенджерах, фото" };
  if (speed >= 0.5) return { word: "слабо", level: 2, can: "сообщения, почта, карта" };
  if (speed >= 0.05) return { word: "едва", level: 1, can: "только текстовые сообщения" };
  if (speed > 0) return { word: "почти нет", level: 1, can: "может пройти короткое сообщение" };
  return { word: "нет связи", level: 1, can: "попробуйте выше или на открытом месте" };
}

/**
 * Класс связи «как 2G/3G/4G/5G» — по измеренной скорости и пингу.
 * Настоящий тип сети браузер не видит, поэтому это оценка: на что связи реально хватает.
 */
export function netClass(speed, ping) {
  if (!(speed > 0)) return "";
  if (speed < 0.1 || (ping != null && ping > 1000)) return "2G";
  if (speed < 3) return "3G";
  if (speed >= 50 && (ping == null || ping <= 35)) return "5G";
  return "4G";
}

/** Скорость в удобных единицах: бит/с, кбит/с или Мбит/с. */
export function speedParts(speed) {
  const bps = speed * 1e6;
  if (bps <= 0) return { value: "0", unit: "бит/с" };
  if (bps < 1000) return { value: String(Math.round(bps)), unit: "бит/с" };
  if (bps < 1e6) {
    const k = bps / 1000;
    return { value: (k < 10 ? k.toFixed(2) : k < 100 ? k.toFixed(1) : String(Math.round(k))).replace(".", ","), unit: "кбит/с" };
  }
  return { value: fmt(speed), unit: "Мбит/с" };
}

/** Точное число бит в секунду с пробелами: 482315 → «482 315». */
export function exactBits(speed) {
  return String(Math.round(speed * 1e6)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Положение стрелки прибора 0..1 по логарифмической шкале 1 кбит/с – 100 Мбит/с. */
export function gaugePos(speed) {
  if (!speed || speed <= 0.001) return 0;
  return Math.min(1, Math.log10(speed / 0.001) / 5);
}

/** Красиво: 0.56 → «0,56», 12.3 → «12». */
export function fmt(speed) {
  const n = speed >= 10 ? Math.round(speed) : Math.round(speed * 100) / 100;
  return String(n).replace(".", ",");
}

/**
 * Места: замеры ближе radius метров друг к другу считаются одним местом.
 * Скорость места — средняя по его замерам. Сортировка: лучшие сверху.
 */
export function places(measures, radius = 15) {
  const withGeo = measures.filter((m) => m.lat != null && m.lon != null && m.ok && plausible(m) && (m.acc == null || m.acc <= GPS_MAX_ERR));
  const groups = [];
  for (const m of withGeo) {
    const g = groups.find((g) => distance(g.center, m) <= radius);
    if (g) {
      g.items.push(m);
      g.center = { lat: avg(g.items.map((i) => i.lat)), lon: avg(g.items.map((i) => i.lon)) };
    } else {
      groups.push({ center: { lat: m.lat, lon: m.lon }, items: [m] });
    }
  }
  return groups
    .map((g) => {
      const sp = g.items.map((i) => i.mbps);
      const med = median(sp);
      const spreadBig = sp.length >= 2 && med > 0 && (Math.max(...sp) - Math.min(...sp)) / med > 1;
      return {
        lat: g.center.lat,
        lon: g.center.lon,
        speed: med, // медиана — случайный пик не поднимает место наверх
        ping: median(g.items.map((i) => i.ping)),
        alt: avg(g.items.map((i) => i.alt).filter((a) => a != null)),
        count: g.items.length,
        bytes: g.items.reduce((s, i) => s + (i.bytes || 0), 0),
        acc: median(g.items.map((i) => i.acc)),
        ins: g.items.some((i) => i.ins),
        stability: g.items.length === 1 ? "1 замер — повторите" : spreadBig ? `разброс большой: ${g.items.length} замера` : `стабильно: ${g.items.length} ${g.items.length < 5 ? "замера" : "замеров"}`,
        label: g.items.map((i) => i.label).filter(Boolean).at(-1) || "",
        last: Math.max(...g.items.map((i) => i.time)),
        score: med * (g.items.length === 1 ? 0.7 : 1), // один замер — меньше доверия: случайный пик не обгонит проверенное место
      };
    })
    .sort((a, b) => b.score - a.score);
}

function avg(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Подсказка «куда идти» от текущей точки к лучшему месту. */
export function hint(here, best) {
  if (!here || !best) return "";
  const d = distance(here, best);
  if (d < 8) return "Вы на лучшем месте";
  const m = d < 1000 ? `${Math.round(d)} м` : `${fmt(d / 1000)} км`;
  return `${m} на ${side(bearing(here, best))}`;
}

// ---------- ИНС: инерциальная навигация по шагам (когда GPS плохой или пропал) ----------

/** Сдвинуть точку на meters метров по направлению headingDeg (0 — север, 90 — восток). */
export function moveBy(p, meters, headingDeg) {
  const h = (headingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(h)) / R;
  const dLon = (meters * Math.sin(h)) / (R * Math.cos(rad(p.lat)));
  return { lat: p.lat + (dLat * 180) / Math.PI, lon: p.lon + (dLon * 180) / Math.PI };
}

/**
 * Шагомер по датчику ускорения. На вход — время (мс) и сила ускорения с учётом тяжести (м/с²).
 * Сглаживаем, ловим подъём выше порога, не чаще одного шага в 280 мс (больше ~3,5 шага/с человек не делает).
 */
export function createStepDetector({ threshold = 1.1, minGap = 280 } = {}) {
  let smooth = 9.81, base = 9.81, armed = true, lastStep = -Infinity;
  return function feed(t, magnitude) {
    smooth = smooth * 0.75 + magnitude * 0.25; // убрать дрожание руки
    base = base * 0.98 + magnitude * 0.02; // медленная «середина» (тяжесть)
    const d = smooth - base;
    if (armed && d > threshold && t - lastStep >= minGap) { armed = false; lastStep = t; return true; }
    if (d < threshold * 0.3) armed = true;
    return false;
  };
}

/**
 * Насколько «гуляет» компас: наибольшее отклонение (в градусах) от среднего направления.
 * Средний угол считаем через синусы/косинусы — чтобы 359° и 1° были рядом, а не через весь круг.
 */
export function headingSpread(degs) {
  if (degs.length < 2) return 0;
  const s = degs.reduce((a, d) => a + Math.sin(rad(d)), 0), c = degs.reduce((a, d) => a + Math.cos(rad(d)), 0);
  const mean = (Math.atan2(s, c) * 180) / Math.PI;
  return Math.round(Math.max(...degs.map((d) => Math.abs(((d - mean + 540) % 360) - 180))));
}

/** Длина шага по пройденному: метры по GPS / число шагов. null, если данных мало или результат странный. */
export function stepFromWalk(meters, steps) {
  if (!(steps >= 20) || !(meters >= 15)) return null;
  const cm = Math.round((meters / steps) * 100);
  return cm >= 40 && cm <= 120 ? cm : null;
}

/** Строка точности места крупно: режим и погрешность. */
export function fixStatus({ ins, acc, ageSec, compassBad }) {
  let t;
  if (acc == null) t = "НЕТ МЕСТА · разрешите геолокацию";
  else if (ins) t = `ИНС · ±${Math.round(acc)} м`;
  else if (ageSec != null && ageSec > 20) t = `GPS нет · позиция устаревает ${Math.round(ageSec)} с`;
  else t = `GPS · ±${Math.round(acc)} м`;
  return compassBad ? t + " · ⚠ компас нестабилен" : t;
}

/** Журнал прогулки для разбора ошибок: время, режим, место, точность, шаги, курс и разброс компаса. */
export function trackCSV(track) {
  const head = "Время;Режим;Широта;Долгота;Точность м;Шагов всего;Курс °;Разброс компаса °;Длина шага см;Мбит/с;GPS-точка получена;GPS заявл. точность м";
  const rows = track.map((r) => [
    new Date(r.t).toLocaleTimeString("ru-RU"), r.mode, r.lat?.toFixed(6) ?? "", r.lon?.toFixed(6) ?? "",
    r.acc != null ? Math.round(r.acc) : "", r.steps ?? "", r.hdg != null ? Math.round(r.hdg) : "", r.spread ?? "", r.stepCm ?? "",
    r.mbps != null ? fmt(r.mbps) : "", r.gpsT ? new Date(r.gpsT).toLocaleTimeString("ru-RU") : "", r.gpsAcc != null ? Math.round(r.gpsAcc) : "",
  ].join(";"));
  return [head, ...rows].join("\r\n");
}

/**
 * Погрешность места при счёте по шагам: ошибка последнего GPS + ~5% пройденного.
 * Если компас ненадёжный — направление неточное, погрешность растёт втрое быстрее (~15%).
 */
export function insError(lastGpsAcc, metersSinceFix, compassBad = false) {
  return Math.round((lastGpsAcc ?? 10) + metersSinceFix * (compassBad ? 0.15 : 0.05));
}

/**
 * GPS-фильтр по серии точек, а не по одной.
 * - Режим «плохо» включается, только если 3 свежие точки подряд хуже good метров.
 * - Одиночный выброс (точка прыгнула дальше, чем можно пройти) игнорируется, пока следующая точка его не подтвердит.
 * - После «плохо» GPS считается вернувшимся по 2 согласованным хорошим точкам; место — их среднее с весом по точности.
 * feed({ t, lat, lon, acc }) → { good, pos, acc, changed: "lost" | "back" | null }
 */
export function createGpsFilter({ good = 25, maxSpeed = 8 } = {}) {
  let state = "init", pos = null, posAcc = null, lastT = null, badRun = 0, pend = [], cand = null;
  const wavg = (pts) => {
    const w = pts.map((p) => 1 / Math.max(1, p.acc) ** 2), sw = w.reduce((a, b) => a + b, 0);
    return { lat: pts.reduce((a, p, i) => a + p.lat * w[i], 0) / sw, lon: pts.reduce((a, p, i) => a + p.lon * w[i], 0) / sw, acc: Math.min(...pts.map((p) => p.acc)) };
  };
  return function feed(f) {
    let changed = null;
    const ok = f.acc <= good;
    if (state === "init") {
      pos = { lat: f.lat, lon: f.lon }; posAcc = f.acc; lastT = f.t; state = ok ? "good" : "bad";
      return { good: ok, pos, acc: posAcc, changed };
    }
    if (state === "good") {
      if (!ok) {
        badRun++;
        if (badRun >= 3) { state = "bad"; changed = "lost"; pend = []; }
        return { good: state === "good", pos, acc: posAcc, changed };
      }
      badRun = 0;
      const dt = Math.max(1, (f.t - lastT) / 1000);
      const jump = distance(pos, f);
      if (jump > posAcc + f.acc + maxSpeed * dt) {
        // выброс? ждём подтверждения следующей точкой
        if (cand && distance(cand, f) <= cand.acc + f.acc) { const m = wavg([cand, f]); pos = { lat: m.lat, lon: m.lon }; posAcc = m.acc; lastT = f.t; cand = null; }
        else cand = { ...f };
        return { good: true, pos, acc: posAcc, changed };
      }
      cand = null; pos = { lat: f.lat, lon: f.lon }; posAcc = f.acc; lastT = f.t;
      return { good: true, pos, acc: posAcc, changed };
    }
    // state === "bad": ждём 2 согласованные хорошие точки
    if (!ok) { pend = []; return { good: false, pos, acc: posAcc, changed }; }
    pend.push({ ...f });
    if (pend.length > 2) pend.shift();
    if (pend.length === 2 && distance(pend[0], pend[1]) <= pend[0].acc + pend[1].acc) {
      const m = wavg(pend);
      pos = { lat: m.lat, lon: m.lon }; posAcc = m.acc; lastT = f.t; state = "good"; badRun = 0; pend = []; changed = "back";
    }
    return { good: state === "good", pos, acc: posAcc, changed };
  };
}

/**
 * ЛОКАТОР: путь от точки к точке к лучшему месту.
 * Идём по уже пройденным местам (они рядом друг с другом), чтобы вести тем путём, где человек уже был.
 * Соседи — места не дальше maxHop метров. Ищем самый короткий путь (Дейкстра) от ближайшего к человеку места до лучшего.
 * Если пройденного пути нет — одна точка: сразу лучшее место.
 * Возвращает массив мест (без текущего положения), последнее — лучшее.
 */
export function route(here, P, maxHop = 60) {
  if (!here || !P.length) return [];
  const best = P[0];
  if (distance(here, best) < 8) return [best];
  const n = P.length;
  let start = 0;
  for (let i = 1; i < n; i++) if (distance(here, P[i]) < distance(here, P[start])) start = i;
  if (start === 0) return [best];
  const dist = Array(n).fill(Infinity), prev = Array(n).fill(-1), done = Array(n).fill(false);
  dist[start] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === 0) break;
    done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v]) continue;
      const d = distance(P[u], P[v]);
      if (d <= maxHop && dist[u] + d < dist[v]) { dist[v] = dist[u] + d; prev[v] = u; }
    }
  }
  if (dist[0] === Infinity) return [best]; // пути по точкам нет — прямо к цели
  const path = [];
  for (let v = 0; v !== -1; v = prev[v]) path.unshift(P[v]);
  // Первую точку пропускаем, если она совсем рядом — человек уже на ней.
  if (path.length > 1 && distance(here, path[0]) < 8) path.shift();
  return path;
}

/** Положение точки на экране радара относительно человека: x вправо (восток), y вниз (юг), в метрах. */
export function offset(here, p) {
  const d = distance(here, p);
  const b = (bearing(here, p) * Math.PI) / 180;
  return { x: d * Math.sin(b), y: -d * Math.cos(b), d };
}

/**
 * Подсказка по высоте. GPS-высота неточная (±10–20 м), поэтому разницу меньше 8 м не считаем.
 * here/best: { alt } в метрах. Возвращает текст или "".
 */
export function altHint(hereAlt, bestAlt) {
  if (hereAlt == null || bestAlt == null) return "";
  const d = Math.round(bestAlt - hereAlt);
  if (d >= 8) return `лучшее место выше на ~${d} м — поднимитесь`;
  if (d <= -8) return `лучшее место ниже на ~${-d} м`;
  return "высота почти та же";
}

/** Средняя высота лучших и худших замеров: помогает понять, «ловит ли выше» в этой местности. */
export function altTrend(measures) {
  const withAlt = measures.filter((m) => m.ok && m.alt != null);
  if (withAlt.length < 4) return "";
  const sorted = [...withAlt].sort((a, b) => b.mbps - a.mbps);
  const half = Math.floor(sorted.length / 2);
  const avgAlt = (xs) => xs.reduce((s, m) => s + m.alt, 0) / xs.length;
  const d = Math.round(avgAlt(sorted.slice(0, half)) - avgAlt(sorted.slice(-half)));
  if (d >= 5) return `Здесь связь лучше выше: хорошие точки в среднем на ${d} м выше плохих`;
  if (d <= -5) return `Здесь связь лучше ниже: хорошие точки в среднем на ${-d} м ниже`;
  return "";
}

/** Таблица для Excel (CSV, разделитель «;»). */
export function toCSV(measures) {
  const head = "Дата;Время;Мбит/с;Бит/с точно;Байт скачано;Время замера мс;Пинг мс;Широта;Долгота;Точность м;Высота м;Сеть;Метка";
  const rows = measures.map((m) => {
    const d = new Date(m.time);
    const date = d.toLocaleDateString("ru-RU");
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const clean = (s) => String(s ?? "").replace(/[;\n\r]/g, " ");
    return [date, time, fmt(m.mbps), Math.round(m.mbps * 1e6), m.bytes ?? "", m.ms != null ? Math.round(m.ms) : "", m.ping ?? "", m.lat ?? "", m.lon ?? "", m.acc != null ? Math.round(m.acc) : "", m.alt != null ? Math.round(m.alt) : "", clean(m.net), clean(m.label)].join(";");
  });
  return [head, ...rows].join("\r\n");
}
