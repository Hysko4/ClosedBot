import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSchedule, nextRun, normalizeSchedule } from "../src/schedule.js";

/** Un miércoles cualquiera lejos de cambios de horario, en hora local. */
function wednesday(hours: number, minutes = 0): Date {
  const date = new Date(2026, 5, 10, hours, minutes);
  while (date.getDay() !== 3) date.setDate(date.getDate() + 1);
  return date;
}

test("horarios: normaliza horas, días e intervalos", () => {
  assert.deepEqual(normalizeSchedule({ times: ["18:00", "9:05", "18:00"] }), { times: ["09:05", "18:00"] });
  assert.deepEqual(normalizeSchedule({ times: "07:30", days: [5, 1, 1] }), { times: ["07:30"], days: [1, 5] });
  assert.deepEqual(normalizeSchedule({ times: ["07:30"], days: [0, 1, 2, 3, 4, 5, 6] }), { times: ["07:30"] }, "los 7 días = todos");
  assert.deepEqual(normalizeSchedule({ everyMinutes: 90 }), { everyMinutes: 90 });
  for (const [input, pattern] of [
    [{}, /uno de los dos/],
    [{ times: ["09:00"], everyMinutes: 60 }, /uno de los dos/],
    [{ times: ["24:00"] }, /Hora inválida/],
    [{ times: ["9am"] }, /Hora inválida/],
    [{ everyMinutes: 10 }, /entre 15/],
    [{ everyMinutes: 30.5 }, /entero/],
    [{ everyMinutes: 60, days: [1] }, /horas fijas/],
    [{ times: ["09:00"], days: [7] }, /de 0/],
  ] as const) {
    assert.throws(() => normalizeSchedule(input), pattern, JSON.stringify(input));
  }
});

test("horarios: calcula la próxima ejecución en hora local", () => {
  const twice = { times: ["09:00", "18:00"] };
  assert.equal(nextRun(twice, wednesday(10).getTime()), wednesday(18).getTime());
  const thursday = wednesday(9);
  thursday.setDate(thursday.getDate() + 1);
  assert.equal(nextRun(twice, wednesday(18).getTime()), thursday.getTime(), "estrictamente después");
  const monday = wednesday(9);
  monday.setDate(monday.getDate() + 5);
  assert.equal(monday.getDay(), 1);
  assert.equal(nextRun({ times: ["09:00"], days: [1] }, wednesday(10).getTime()), monday.getTime());
  const nextWeek = wednesday(9);
  nextWeek.setDate(nextWeek.getDate() + 7);
  assert.equal(nextRun({ times: ["09:00"], days: [3] }, wednesday(9).getTime()), nextWeek.getTime(), "el mismo día de la semana siguiente");
  const start = wednesday(10).getTime();
  assert.equal(nextRun({ everyMinutes: 30 }, start), start + 30 * 60_000);
});

test("horarios: se describen en español", () => {
  assert.equal(describeSchedule({ times: ["09:00", "18:00"] }), "todos los días a las 09:00 y 18:00");
  assert.equal(describeSchedule({ times: ["08:30"], days: [1, 2, 3, 4, 5] }), "de lunes a viernes a las 08:30");
  assert.equal(describeSchedule({ times: ["10:00"], days: [0, 6] }), "sábados y domingos a las 10:00");
  assert.equal(describeSchedule({ times: ["09:00"], days: [1] }), "cada lunes a las 09:00");
  assert.equal(describeSchedule({ times: ["07:00"], days: [0, 1, 3] }), "lun, mié y dom a las 07:00");
  assert.equal(describeSchedule({ everyMinutes: 15 }), "cada 15 min");
  assert.equal(describeSchedule({ everyMinutes: 60 }), "cada hora");
  assert.equal(describeSchedule({ everyMinutes: 120 }), "cada 2 horas");
  assert.equal(describeSchedule({ everyMinutes: 90 }), "cada 1 h 30 min");
  assert.equal(describeSchedule({ everyMinutes: 1_440 }), "cada día");
  assert.equal(describeSchedule({ everyMinutes: 10_080 }), "cada semana");
});
