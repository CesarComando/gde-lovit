// Проверки «сердца». Запуск: node --test tests/  (без интернета и без телефона)
import assert from "node:assert/strict";
import { test } from "node:test";
import { altHint, altTrend, bearing, confidence, distance, exactBits, fmt, gaugePos, grade, hint, mbps, median, offset, places, plausible, route, side, speedParts, toCSV } from "../core.js";

const A = { lat: 55.8849, lon: 26.5009 };

test("расстояние и направление", () => {
  const north = { lat: A.lat + 0.001, lon: A.lon }; // ~111 м на север
  assert.ok(Math.abs(distance(A, north) - 111) < 2);
  assert.equal(side(bearing(A, north)), "север");
  const east = { lat: A.lat, lon: A.lon + 0.002 };
  assert.equal(side(bearing(A, east)), "восток");
});

test("скорость и оценка", () => {
  assert.equal(mbps(1_000_000, 1000), 8);
  assert.equal(mbps(100, 0), 0);
  assert.equal(grade(25).word, "отлично");
  assert.equal(grade(0.56).word, "слабо");
  assert.equal(grade(0.1).word, "едва");
  assert.equal(grade(0.01).word, "почти нет");
  assert.equal(grade(0).word, "нет связи");
  assert.equal(fmt(0.564), "0,56");
  assert.equal(fmt(12.4), "12");
  assert.equal(gaugePos(0), 0);
  assert.ok(Math.abs(gaugePos(1) - 0.6) < 1e-9);
  assert.equal(gaugePos(500), 1);
});

test("точность до бита и удобные единицы", () => {
  assert.deepEqual(speedParts(0.000482), { value: "482", unit: "бит/с" });
  assert.deepEqual(speedParts(0.004823), { value: "4,82", unit: "кбит/с" });
  assert.deepEqual(speedParts(0.4823), { value: "482", unit: "кбит/с" });
  assert.deepEqual(speedParts(4.5), { value: "4,5", unit: "Мбит/с" });
  assert.equal(exactBits(0.482315), "482 315");
  assert.equal(exactBits(mbps(361236, 6000)), "481 648");
});

test("близкие замеры — одно место, лучшие сверху, без GPS не считаются", () => {
  const ms = [
    { ...A, mbps: 1, ok: true, time: 1, ping: 100 },
    { lat: A.lat + 0.00005, lon: A.lon, mbps: 3, ok: true, time: 2, ping: 80, label: "крыльцо" }, // ~5 м
    { lat: A.lat + 0.001, lon: A.lon, mbps: 20, ok: true, time: 3, ping: 30 },
    { lat: null, lon: null, mbps: 50, ok: true, time: 4 },
    { ...A, mbps: 0, ok: false, time: 5 },
  ];
  const p = places(ms);
  assert.equal(p.length, 2);
  assert.equal(p[0].speed, 20);
  assert.equal(p[1].count, 2);
  assert.equal(p[1].speed, 2);
  assert.equal(p[1].label, "крыльцо");
  assert.match(hint(A, p[0]), /^111 м на север$/);
  assert.equal(hint(A, p[1]), "Вы на лучшем месте");
});

test("предохранители: невозможные числа, точность, сглаживание, плохой GPS", () => {
  assert.equal(plausible({ ok: true, mbps: 5000, bytes: 1, ms: 1000 }), false);
  assert.equal(plausible({ ok: true, mbps: 50, bytes: 1_000_000, ms: 20 }), false);
  assert.equal(plausible({ ok: true, mbps: NaN }), false);
  assert.equal(plausible({ ok: true, mbps: 12, bytes: 9_000_000, ms: 6000, ping: 30 }), true);
  assert.equal(plausible({ ok: false }), true);
  assert.equal(confidence(5_000_000, 6000).word, "высокая");
  assert.equal(confidence(72_000, 12000).word, "средняя");
  assert.equal(confidence(4_000, 2500).word, "низкая");
  assert.equal(confidence(900_000, 500).word, "низкая");
  assert.equal(median([1, 100, 2]), 2);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([]), null);
  const P = places([
    { ...A, mbps: 50, ok: true, time: 1, acc: 300 }, // GPS ±300 м — не годится
    { ...A, mbps: 9000, ok: true, time: 2, acc: 5, bytes: 1, ms: 1000 }, // невозможно
    { ...A, mbps: 2, ok: true, time: 3, acc: 8 },
  ]);
  assert.equal(P.length, 1);
  assert.equal(P[0].speed, 2);
});

test("локатор: путь по пройденным точкам к лучшему месту", () => {
  // Человек прошёл тропу на север по 30 м; лучшая связь в конце (150 м). Сейчас стоит в начале.
  const step = 0.00027; // ~30 м
  const trail = [0, 1, 2, 3, 4, 5].map((i) => ({ lat: A.lat + i * step, lon: A.lon, speed: i === 5 ? 10 : 0.1 * (i + 1) }));
  const P = [...trail].sort((a, b) => b.speed - a.speed);
  const r = route(A, P);
  assert.equal(r.length, 5, "ведёт через 4 промежуточные точки к цели");
  assert.equal(r.at(-1).speed, 10);
  assert.ok(distance(A, r[0]) < 40, "первая точка — ближайшая");
  // Если точки далеко друг от друга — сразу к цели.
  const far = [{ lat: A.lat + 0.01, lon: A.lon, speed: 5 }, { lat: A.lat + 0.0001, lon: A.lon + 0.005, speed: 1 }];
  assert.equal(route(A, far).length, 1);
  // Уже на месте.
  assert.equal(route(trail[5], P).length, 1);
  const o = offset(A, { lat: A.lat + 0.001, lon: A.lon });
  assert.ok(Math.abs(o.x) < 0.5 && o.y < -100);
});

test("подсказки по высоте", () => {
  assert.equal(altHint(120, 140), "лучшее место выше на ~20 м — поднимитесь");
  assert.equal(altHint(120, 125), "высота почти та же");
  assert.equal(altHint(null, 140), "");
  const ms = [10, 8, 1, 0.5].map((v, i) => ({ ok: true, mbps: v, alt: [150, 148, 120, 118][i] }));
  assert.match(altTrend(ms), /лучше выше: .* на 30 м/);
  assert.equal(altTrend(ms.slice(0, 3)), "");
});

test("CSV для Excel", () => {
  const csv = toCSV([{ time: Date.UTC(2026, 10, 22, 10, 0), mbps: 0.56, ping: 120, lat: 1, lon: 2, acc: 9.6, net: "4g", label: "у окна; кухня" }]);
  const [head, row] = csv.split("\r\n");
  assert.equal(head.split(";").length, 13);
  assert.equal(row.split(";").length, 13);
  assert.ok(row.includes(";560000;"));
  assert.ok(row.includes("0,56") && row.includes("у окна  кухня"));
});
