import { describe, expect, it } from 'vitest';
import { cleanTimes, evenSpacing, fmtMinute, minuteOf, normalizeTime } from './schedule';

describe('normalizeTime', () => {
  it('accepts what people type and stores one form', () => {
    expect(normalizeTime('03:30')).toBe('03:30');
    expect(normalizeTime('3:5')).toBe('03:05');
    expect(normalizeTime(' 23:59 ')).toBe('23:59');
    expect(normalizeTime('00:00')).toBe('00:00');
  });

  it('rejects what the daemon would silently drop', () => {
    expect(normalizeTime('24:00')).toBeNull();
    expect(normalizeTime('12:60')).toBeNull();
    expect(normalizeTime('1230')).toBeNull();
    expect(normalizeTime('noon')).toBeNull();
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime('12:30:00')).toBeNull();
  });
});

describe('minuteOf and fmtMinute', () => {
  it('round-trips, and wraps', () => {
    expect(minuteOf('03:30')).toBe(210);
    expect(fmtMinute(210)).toBe('03:30');
    expect(fmtMinute(0)).toBe('00:00');
    expect(fmtMinute(1440)).toBe('00:00');
    expect(minuteOf('nope')).toBeNull();
  });
});

describe('evenSpacing', () => {
  it('matches the daemon: anchors at the base time and steps evenly', () => {
    expect(evenSpacing('03:30', 1)).toEqual(['03:30']);
    expect(evenSpacing('03:30', 2)).toEqual(['03:30', '15:30']);
    expect(evenSpacing('03:30', 4)).toEqual(['03:30', '09:30', '15:30', '21:30']);
  });

  it('wraps past midnight', () => {
    expect(evenSpacing('22:00', 2)).toEqual(['22:00', '10:00']);
    expect(evenSpacing('22:00', 3)).toEqual(['22:00', '06:00', '14:00']);
  });

  it('never returns nothing for a usable input, and nothing for a broken one', () => {
    expect(evenSpacing('03:30', 0)).toEqual(['03:30']);
    expect(evenSpacing('03:30', -3)).toEqual(['03:30']);
    expect(evenSpacing('half past', 2)).toEqual([]);
  });
});

describe('cleanTimes', () => {
  it('normalises, sorts and de-duplicates', () => {
    expect(cleanTimes(['15:30', '6:5', '15:30', '03:30'])).toEqual(['03:30', '06:05', '15:30']);
  });

  it('refuses the whole list when one entry is not a time', () => {
    expect(cleanTimes(['03:30', '25:00'])).toBeNull();
    expect(cleanTimes([])).toEqual([]);
  });
});
