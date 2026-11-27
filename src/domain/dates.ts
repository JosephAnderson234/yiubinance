// Fechas como 'YYYY-MM-DD' en hora de Lima (UTC-5 fijo: Perú no tiene horario de verano).
export type Day = string;
const OFFSET_MS = 5 * 3600_000;
const DAY_MS = 86_400_000;

const toMs = (d: Day) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number): Day => new Date(ms).toISOString().slice(0, 10);

export const localDay = (ms = Date.now()): Day => fromMs(ms - OFFSET_MS);
export const localHour = (ms = Date.now()) => new Date(ms - OFFSET_MS).getUTCHours();
export const addDays = (d: Day, n: number): Day => fromMs(toMs(d) + n * DAY_MS);
export const diffDays = (a: Day, b: Day) => Math.round((toMs(a) - toMs(b)) / DAY_MS);
export const weekday = (d: Day) => new Date(toMs(d)).getUTCDay();

/** Día `day` del mes de `ref + offset`, recortado al último día si el mes es más corto. */
export function monthDay(ref: Day, day: number, offset = 0): Day {
  const r = new Date(toMs(ref));
  const y = r.getUTCFullYear();
  const m = r.getUTCMonth() + offset;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromMs(Date.UTC(y, m, Math.min(day, last)));
}

/** Última fecha con ese día del mes en o antes de `d`. */
export function prevMonthly(d: Day, day: number): Day {
  const here = monthDay(d, day);
  return here <= d ? here : monthDay(d, day, -1);
}

/** Primera fecha con ese día del mes estrictamente después de `d`. */
export function nextMonthlyAfter(d: Day, day: number): Day {
  const here = monthDay(d, day);
  return here > d ? here : monthDay(d, day, 1);
}

/** Primera fecha con ese día del mes en o después de `d`. */
export function nextMonthlyOn(d: Day, day: number): Day {
  const here = monthDay(d, day);
  return here >= d ? here : monthDay(d, day, 1);
}

export const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
