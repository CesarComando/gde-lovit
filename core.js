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

/** Оценка словами и цветом. */
export function grade(speed) {
  if (speed >= 10) return { word: "отлично", level: 4 };
  if (speed >= 3) return { word: "нормально", level: 3 };
  if (speed >= 0.5) return { word: "слабо", level: 2 };
  return { word: "очень плохо", level: 1 };
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
  const withGeo = measures.filter((m) => m.lat != null && m.lon != null && m.ok);
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

/** Таблица для Excel (CSV, разделитель «;»). */
export function toCSV(measures) {
  const head = "Дата;Время;Мбит/с;Пинг мс;Широта;Долгота;Точность м;Сеть;Метка";
  const rows = measures.map((m) => {
    const d = new Date(m.time);
    const date = d.toLocaleDateString("ru-RU");
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const clean = (s) => String(s ?? "").replace(/[;\n\r]/g, " ");
    return [date, time, fmt(m.mbps), m.ping ?? "", m.lat ?? "", m.lon ?? "", m.acc != null ? Math.round(m.acc) : "", clean(m.net), clean(m.label)].join(";");
  });
  return [head, ...rows].join("\r\n");
}
