import { normalizeTime } from './schema';

/**
 * The schedule arithmetic the Dashboard previews with.
 *
 * It deliberately mirrors the daemon's rule (see `scheduler::schedule_minutes` in
 * src/scheduler.rs): N runs a day, evenly spaced from the first one. If the two
 * ever disagree the panel would promise times the daemon never fires, so keep this
 * in step with the Rust.
 */

export { normalizeTime };

/** Minutes since midnight, or null when it is not a 24-hour time. */
export function minuteOf(time: string): number | null {
  const norm = normalizeTime(time);
  if (!norm) return null;
  const [h, m] = norm.split(':').map(Number);
  return h * 60 + m;
}

/** Minutes since midnight back to "HH:MM". */
export function fmtMinute(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/**
 * Evenly distributed run times across a day, anchored at `base`.
 *
 * Returns [] for an unparseable time so callers can show "—" rather than a
 * schedule that cannot exist.
 */
export function evenSpacing(base: string, perDay: number): string[] {
  const start = minuteOf(base);
  if (start === null) return [];
  const n = Math.max(1, Math.floor(perDay) || 1);
  const step = Math.floor(1440 / n);
  return Array.from({ length: n }, (_, k) => fmtMinute((start + k * step) % 1440));
}

/** One backup time per entry, normalised, de-duplicated and in clock order. */
export function cleanTimes(times: string[]): string[] | null {
  const cleaned: string[] = [];
  for (const t of times) {
    const norm = normalizeTime(t);
    if (!norm) return null;
    cleaned.push(norm);
  }
  return [...new Set(cleaned)].sort();
}
