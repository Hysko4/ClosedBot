/**
 * Horarios de las rutinas: horas fijas (opcionalmente solo algunos días) o cada N minutos.
 * Las horas son locales del equipo donde corre Cuadrilla.
 */
export interface Schedule {
  /** Horas locales «HH:MM», ordenadas y sin repetir. */
  times?: string[];
  /** Días de la semana (0 = domingo … 6 = sábado); ausente = todos los días. Solo con `times`. */
  days?: number[];
  /** Cada cuántos minutos (de 15 a 10.080, una semana). Excluye `times`. */
  everyMinutes?: number;
}

export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_TIMES = 12;

const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DAY_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/** Valida y deja en forma canónica un horario recibido de un agente o de la interfaz. */
export function normalizeSchedule(input: { times?: unknown; days?: unknown; everyMinutes?: unknown }): Schedule {
  const hasTimes = input.times !== undefined && input.times !== null && !(Array.isArray(input.times) && input.times.length === 0);
  const hasInterval = input.everyMinutes !== undefined && input.everyMinutes !== null;
  if (hasTimes === hasInterval) throw new Error("Indica horas fijas (times) o un intervalo en minutos (everyMinutes), uno de los dos.");
  if (hasInterval) {
    const minutes = Number(input.everyMinutes);
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      throw new Error(`El intervalo debe ser un número entero de minutos entre ${MIN_INTERVAL_MINUTES} y ${MAX_INTERVAL_MINUTES}.`);
    }
    if (input.days !== undefined && input.days !== null && !(Array.isArray(input.days) && input.days.length === 0)) {
      throw new Error("Los días solo se pueden combinar con horas fijas.");
    }
    return { everyMinutes: minutes };
  }
  const rawTimes = typeof input.times === "string" ? [input.times] : input.times;
  if (!Array.isArray(rawTimes)) throw new Error("`times` debe ser una lista de horas «HH:MM».");
  const times = [...new Set(rawTimes.map(parseTime))].sort();
  if (times.length > MAX_TIMES) throw new Error(`Máximo ${MAX_TIMES} horas por rutina.`);
  const schedule: Schedule = { times };
  if (input.days !== undefined && input.days !== null) {
    if (!Array.isArray(input.days)) throw new Error("`days` debe ser una lista de días (0 = domingo … 6 = sábado).");
    const days = [...new Set(input.days.map(Number))].sort((a, b) => a - b);
    if (!days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
      throw new Error("Cada día debe ser un número de 0 (domingo) a 6 (sábado).");
    }
    if (days.length > 0 && days.length < 7) schedule.days = days;
  }
  return schedule;
}

function parseTime(value: unknown): string {
  const match = typeof value === "string" ? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value) : null;
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) throw new Error(`Hora inválida: ${JSON.stringify(value)}. Usa el formato HH:MM (por ejemplo 09:30).`);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Próxima ejecución estrictamente posterior a `after` (milisegundos), en hora local. */
export function nextRun(schedule: Schedule, after: number): number | null {
  if (schedule.everyMinutes) return after + schedule.everyMinutes * 60_000;
  const times = schedule.times ?? [];
  if (!times.length) return null;
  const start = new Date(after);
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (schedule.days && !schedule.days.includes(day.getDay())) continue;
    for (const time of times) {
      const [hours, minutes] = time.split(":").map(Number);
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes).getTime();
      if (candidate > after) return candidate;
    }
  }
  return null;
}

/** Descripción en español, p. ej. «de lunes a viernes a las 09:00» o «cada 2 horas». */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.everyMinutes) return describeInterval(schedule.everyMinutes);
  const times = schedule.times ?? [];
  const at = times.length === 1 ? `a las ${times[0]}` : `a las ${joinList(times)}`;
  return `${describeDays(schedule.days)} ${at}`;
}

function describeInterval(total: number): string {
  if (total % (24 * 60) === 0) {
    const days = total / (24 * 60);
    return days === 1 ? "cada día" : days === 7 ? "cada semana" : `cada ${days} días`;
  }
  if (total % 60 === 0) {
    const hours = total / 60;
    return hours === 1 ? "cada hora" : `cada ${hours} horas`;
  }
  if (total < 60) return `cada ${total} min`;
  return `cada ${Math.floor(total / 60)} h ${total % 60} min`;
}

function describeDays(days: number[] | undefined): string {
  if (!days || days.length === 0 || days.length === 7) return "todos los días";
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "de lunes a viernes";
  if (key === "0,6") return "sábados y domingos";
  if (days.length === 1) return `cada ${DAY_NAMES[days[0] ?? 0]}`;
  // Lunes primero, como en el calendario chileno.
  const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return joinList(ordered.map((day) => DAY_SHORT[day] ?? "?"));
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}
