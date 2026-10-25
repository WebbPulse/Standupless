/**
 * Relative date bounds: that each offset resolves by calendar the way the
 * backend does, that absolute days pass through, and that a bound round trips
 * into the words its chip reads.
 */

import { describe, expect, it } from 'vitest';
import {
  dayBoundChip,
  dayLabel,
  isDayBound,
  isRelativeDay,
  relativeDayLabel,
  resolveDayBound,
  utcToday,
} from './filterDays';

const today = new Date(2026, 2, 31);

describe('resolveDayBound', () => {
  it.each([
    ['today', '2026-03-31'],
    ['-14d', '2026-03-17'],
    ['+7d', '2026-04-07'],
    ['-2w', '2026-03-17'],
    ['-1m', '2026-02-28'],
    ['+1m', '2026-04-30'],
    ['-3m', '2025-12-31'],
    ['-1y', '2025-03-31'],
  ])('resolves %s by calendar', (bound, day) => {
    expect(resolveDayBound(bound, today)).toBe(day);
  });

  it('returns an absolute day untouched', () => {
    expect(resolveDayBound('2026-10-01', today)).toBe('2026-10-01');
  });
});

describe('bounds', () => {
  it('accepts days and offsets and refuses the rest', () => {
    expect(isDayBound('2026-10-01')).toBe(true);
    expect(isDayBound('-2w')).toBe(true);
    expect(isDayBound('today')).toBe(true);
    expect(isDayBound('-2weeks')).toBe(false);
    expect(isDayBound('June')).toBe(false);
    expect(isRelativeDay('2026-10-01')).toBe(false);
  });

  it('reads the UTC day as a local date', () => {
    const day = utcToday(new Date(Date.UTC(2026, 9, 25, 23, 30)));
    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([
      2026, 9, 25,
    ]);
  });
});

describe('chip labels', () => {
  it.each([
    ['after', '-2w', 'in the last', '2 weeks'],
    ['after', '-1d', 'in the last', '1 day'],
    ['before', '+1w', 'within', '1 week'],
    ['before', '+3m', 'within', '3 months'],
    ['before', '-1m', 'before', '1 month ago'],
    ['after', '+2w', 'after', 'in 2 weeks'],
    ['before', 'today', 'before', 'today'],
  ] as const)('reads %s %s as %s %s', (op, bound, verb, summary) => {
    expect(dayBoundChip(op, bound)).toEqual({ verb, summary });
  });

  it('keeps the verb and the date for an absolute day', () => {
    const chip = dayBoundChip('after', '2026-10-01');
    expect(chip.verb).toBe('after');
    expect(chip.summary).toBe(dayLabel('2026-10-01'));
    expect(chip.summary).not.toBe('2026-10-01');
  });

  it('names presets in words', () => {
    expect(relativeDayLabel('today')).toBe('Today');
    expect(relativeDayLabel('+1d')).toBe('Tomorrow');
    expect(relativeDayLabel('-3m')).toBe('3 months ago');
    expect(relativeDayLabel('+1w')).toBe('In 1 week');
  });
});
