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
    .map((g) => ({
      lat: g.center.lat,
      lon: g.center.lon,
      speed: avg(g.items.map((i) => i.mbps)),
      ping: avg(g.items.map((i) => i.ping).filter((p) => p != null)),
      alt: avg(g.items.map((i) => i.alt).filter((a) => a != null)),
      count: g.items.length,
      label: g.items.map((i) => i.label).filter(Boolean).at(-1) || "",
      last: Math.max(...g.items.map((i) => i.time)),
    }))
    .sort((a, b) => b.speed - a.speed);
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
