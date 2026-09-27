/**
 * The snooze presets. Covers that each lands in the future and inside the
 * server's 90 day bound, that the morning presets land at 09:00 local, and
 * that next week from a Monday is a full week out rather than today.
 */

import { describe, expect, it } from 'vitest';
import { SNOOZE_PRESETS, snoozeLabel } from './snooze';

const preset = (id: string) => {
  const found = SNOOZE_PRESETS.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found;
};

describe('snooze presets', () => {
  it('each lands after now and within 90 days', () => {
    const now = new Date(2026, 8, 26, 23, 30);
    for (const one of SNOOZE_PRESETS) {
      const until = one.until(now).getTime();
      expect(until).toBeGreaterThan(now.getTime() + 60_000);
      expect(until).toBeLessThan(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    }
  });

  it('tomorrow is the next morning at nine', () => {
    const until = preset('tomorrow').until(new Date(2026, 8, 26, 23, 30));
    expect(until.getDate()).toBe(27);
    expect(until.getHours()).toBe(9);
    expect(until.getMinutes()).toBe(0);
  });

  it('next week from a Monday is the following Monday', () => {
    const monday = new Date(2026, 8, 28, 8, 0);
    const until = preset('week').until(monday);
    expect(until.getDay()).toBe(1);
    expect(until.getDate()).toBe(5);
  });

  it('next week from a Saturday is two days out', () => {
    const until = preset('week').until(new Date(2026, 8, 26, 12, 0));
    expect(until.getDay()).toBe(1);
    expect(until.getDate()).toBe(28);
  });

  it('labels a moment and falls back on a bad one', () => {
    expect(snoozeLabel('2026-12-01T17:00:00Z')).toMatch(/^Snoozed until /);
    expect(snoozeLabel('not a date')).toBe('Snoozed');
  });
});
