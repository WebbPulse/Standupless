/**
 * The cycle schedule helpers: the patch body carries only what changed, and
 * the preview lands on the start weekday no earlier than tomorrow.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CYCLE_SCHEDULE,
  formatPreviewDate,
  previewNextCycle,
  scheduleChanges,
  weeksLabel,
} from './cycleSettings';

describe('scheduleChanges', () => {
  it('answers an empty body when nothing changed', () => {
    expect(
      scheduleChanges(DEFAULT_CYCLE_SCHEDULE, { ...DEFAULT_CYCLE_SCHEDULE })
    ).toEqual({});
  });

  it('carries only the changed fields', () => {
    expect(
      scheduleChanges(DEFAULT_CYCLE_SCHEDULE, {
        ...DEFAULT_CYCLE_SCHEDULE,
        enabled: true,
        cooldown_weeks: 1,
      })
    ).toEqual({ enabled: true, cooldown_weeks: 1 });
  });
});

describe('previewNextCycle', () => {
  it('starts on the next start weekday after today', () => {
    const today = new Date(2026, 8, 26);
    const { start, end } = previewNextCycle(
      { start_weekday: 0, duration_weeks: 2 },
      today
    );

    expect(formatPreviewDate(start)).toBe('Mon, Sep 28');
    expect(formatPreviewDate(end)).toBe('Sun, Oct 11');
  });

  it('starts tomorrow when tomorrow is the start weekday', () => {
    const today = new Date(2026, 8, 27);
    const { start, end } = previewNextCycle(
      { start_weekday: 0, duration_weeks: 1 },
      today
    );

    expect(formatPreviewDate(start)).toBe('Mon, Sep 28');
    expect(formatPreviewDate(end)).toBe('Sun, Oct 4');
  });

  it('never starts today, even on the start weekday', () => {
    const today = new Date(2026, 8, 28);
    const { start } = previewNextCycle(
      { start_weekday: 0, duration_weeks: 2 },
      today
    );

    expect(formatPreviewDate(start)).toBe('Mon, Oct 5');
  });

  it('crosses a month and a year end', () => {
    const today = new Date(2026, 11, 30);
    const { start, end } = previewNextCycle(
      { start_weekday: 4, duration_weeks: 3 },
      today
    );

    expect(formatPreviewDate(start)).toBe('Fri, Jan 1');
    expect(formatPreviewDate(end)).toBe('Thu, Jan 21');
    expect(start.getFullYear()).toBe(2027);
  });
});

describe('weeksLabel', () => {
  it('reads one week in the singular', () => {
    expect(weeksLabel(1)).toBe('1 week');
    expect(weeksLabel(3)).toBe('3 weeks');
  });
});
