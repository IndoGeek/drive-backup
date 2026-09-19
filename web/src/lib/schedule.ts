import { normalizeTime } from './schema';

export { normalizeTime };

export function minuteOf(time: string): number | null {
  const norm = normalizeTime(time);
  if (!norm) return null;
  const [h, m] = norm.split(':').map(Number);
  return h * 60 + m;
}

export function fmtMinute(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

export function evenSpacing(base: string, perDay: number): string[] {
  const start = minuteOf(base);
  if (start === null) return [];
  const n = Math.max(1, Math.floor(perDay) || 1);
  const step = Math.floor(1440 / n);
  return Array.from({ length: n }, (_, k) => fmtMinute((start + k * step) % 1440));
}

export function cleanTimes(times: string[]): string[] | null {
  const cleaned: string[] = [];
  for (const t of times) {
    const norm = normalizeTime(t);
    if (!norm) return null;
    cleaned.push(norm);
  }
  return [...new Set(cleaned)].sort();
}
