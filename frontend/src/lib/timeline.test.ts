/**
 * The roadmap's day arithmetic: parsing dates to day numbers and back, the
 * span the timeline covers, how drags move and resize a bar, and where a
 * label and an off-screen marker sit.
 */

import { describe, expect, it } from 'vitest';
import {
  barDays,
  clampLabel,
  dayNumber,
  dayValue,
  dragBar,
  offscreenSide,
  timelineHeader,
  timelineRange,
} from './timeline';

const day = (value: string): number => {
  const parsed = dayNumber(value);
  if (parsed === null) throw new Error(`bad day ${value}`);
  return parsed;
};

describe('dayNumber and dayValue', () => {
  it('round-trips a calendar date', () => {
    expect(dayValue(day('2026-09-25'))).toBe('2026-09-25');
  });

  it('reads a missing or malformed date as null', () => {
    expect(dayNumber(null)).toBeNull();
    expect(dayNumber('25/09/2026')).toBeNull();
  });
});

describe('timelineRange', () => {
  it('covers today and every date, on whole months', () => {
    const today = day('2026-09-25');
    const range = timelineRange(['2027-06-10', null], today);
    expect(dayValue(range.start).endsWith('-01')).toBe(true);
    expect(dayValue(range.end).endsWith('-01')).toBe(true);
    expect(range.start).toBeLessThan(today);
    expect(range.end).toBeGreaterThan(day('2027-06-10'));
  });
});

describe('timelineHeader', () => {
  it('labels months above Mondays at the month zoom', () => {
    const range = { start: day('2026-09-01'), end: day('2026-11-01') };
    const header = timelineHeader(range, 'month');
    expect(header.major).toHaveLength(2);
    const mondays = header.minor
      .slice(1)
      .map((tick) => new Date(tick.day * 86400000).getUTCDay());
    expect(mondays.length).toBeGreaterThan(0);
    expect(mondays.every((weekday) => weekday === 1)).toBe(true);
  });
});

describe('dragBar', () => {
  const bar = { start: 10, end: 20 };

  it('shifts both ends on a move', () => {
    expect(dragBar(bar, 'move', 3)).toEqual({ start: 13, end: 23 });
  });

  it('never lets the start pass the end', () => {
    expect(dragBar(bar, 'start', 30)).toEqual({ start: 20, end: 20 });
  });

  it('never lets the end pass the start', () => {
    expect(dragBar(bar, 'end', -30)).toEqual({ start: 10, end: 10 });
  });
});

describe('barDays', () => {
  it('is null with neither date', () => {
    expect(barDays(null, null)).toBeNull();
  });

  it('draws a single date as one day', () => {
    const only = day('2026-10-01');
    expect(barDays(null, '2026-10-01')).toEqual({ start: only, end: only });
  });

  it('orders reversed dates', () => {
    expect(barDays('2026-10-05', '2026-10-01')).toEqual({
      start: day('2026-10-01'),
      end: day('2026-10-05'),
    });
  });
});

describe('clampLabel', () => {
  it('sits at the bar start when the start is in view', () => {
    expect(clampLabel(100, 300, 50, 80)).toBe(100);
  });

  it('follows the view edge while the bar start is scrolled away', () => {
    expect(clampLabel(100, 300, 200, 80)).toBe(200);
  });

  it('stops short of the bar end', () => {
    expect(clampLabel(100, 300, 390, 80)).toBe(320);
  });
});

describe('offscreenSide', () => {
  it('says which side a hidden bar lies on', () => {
    expect(offscreenSide(0, 50, 100, 500)).toBe('before');
    expect(offscreenSide(600, 50, 100, 500)).toBe('after');
    expect(offscreenSide(80, 50, 100, 500)).toBeNull();
  });
});
