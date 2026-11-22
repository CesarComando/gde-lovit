// Проверки «сердца». Запуск: node --test tests/  (без интернета и без телефона)
import assert from "node:assert/strict";
import { test } from "node:test";
import { bearing, distance, exactBits, fmt, gaugePos, grade, hint, mbps, places, side, speedParts, toCSV } from "../core.js";

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

test("CSV для Excel", () => {
  const csv = toCSV([{ time: Date.UTC(2026, 10, 22, 10, 0), mbps: 0.56, ping: 120, lat: 1, lon: 2, acc: 9.6, net: "4g", label: "у окна; кухня" }]);
  const [head, row] = csv.split("\r\n");
  assert.equal(head.split(";").length, 12);
  assert.equal(row.split(";").length, 12);
  assert.ok(row.includes(";560000;"));
  assert.ok(row.includes("0,56") && row.includes("у окна  кухня"));
});
