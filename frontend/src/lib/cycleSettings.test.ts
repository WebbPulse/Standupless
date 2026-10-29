/**
 * The cycle schedule helpers: the patch body carries only what changed, and
 * the preview lands on the start weekday no earlier than tomorrow, or after
 * the current cycle and its cooldown when one is running, and a lower upcoming
 * count removes the latest empty automatic cycles without leaving a hole.
 */

import { describe, expect, it } from 'vitest';
import type { CycleRead } from '../types/Api';
import {
  DEFAULT_CYCLE_SCHEDULE,
  formatPreviewDate,
  movesUpcoming,
  parseScheduleDate,
  previewNextCycle,
  previewTrim,
  removableCycle,
  scheduleChanges,
  trimSentence,
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

describe('previewNextCycle after a current cycle', () => {
  it('starts the day after the current cycle ends', () => {
    const { start, end } = previewNextCycle(
      { start_weekday: 0, duration_weeks: 1 },
      new Date(2026, 8, 26),
      new Date(2026, 9, 4)
    );

    expect(formatPreviewDate(start)).toBe('Mon, Oct 5');
    expect(formatPreviewDate(end)).toBe('Sun, Oct 11');
  });

  it('waits out the cooldown and lands on the start weekday', () => {
    const { start } = previewNextCycle(
      { start_weekday: 2, duration_weeks: 2, cooldown_weeks: 1 },
      new Date(2026, 8, 26),
      new Date(2026, 9, 4)
    );

    expect(formatPreviewDate(start)).toBe('Wed, Oct 14');
  });
});

describe('parseScheduleDate', () => {
  it('reads a calendar date as local midnight', () => {
    expect(parseScheduleDate('2026-10-04')).toEqual(new Date(2026, 9, 4));
    expect(parseScheduleDate(undefined)).toBeNull();
  });
});

describe('movesUpcoming', () => {
  it('answers true only for the length, cooldown or start day', () => {
    expect(movesUpcoming({ duration_weeks: 1 })).toBe(true);
    expect(movesUpcoming({ start_weekday: 3 })).toBe(true);
    expect(movesUpcoming({ upcoming_count: 4 })).toBe(false);
  });
});

describe('weeksLabel', () => {
  it('reads one week in the singular', () => {
    expect(weeksLabel(1)).toBe('1 week');
    expect(weeksLabel(3)).toBe('3 weeks');
  });
});

/** An upcoming cycle the schedule made, with any field overridden. */
const auto = (number: number, over: Partial<CycleRead> = {}): CycleRead =>
  ({
    cycle_id: `auto-${String(number)}`,
    team_id: 'team-1',
    name: `Cycle ${String(number)}`,
    number,
    start_date: `2026-11-${String(number).padStart(2, '0')}`,
    end_date: `2026-11-${String(number).padStart(2, '0')}`,
    goal: null,
    cancelled: false,
    status: 'upcoming',
    counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
    created_by: 'system',
    ...over,
  }) as CycleRead;

describe('removableCycle', () => {
  it('takes an empty, untouched automatic cycle', () => {
    expect(removableCycle(auto(2))).toBe(true);
  });

  it('keeps one made by hand, renamed, given a goal or holding issues', () => {
    expect(removableCycle(auto(2, { created_by: 'user-1' }))).toBe(false);
    expect(removableCycle(auto(2, { name: 'Launch' }))).toBe(false);
    expect(removableCycle(auto(2, { goal: 'Ship' }))).toBe(false);
    expect(
      removableCycle(
        auto(2, {
          counts: { todo: 1, in_progress: 0, done: 0, cancelled: 0, total: 1 },
        })
      )
    ).toBe(false);
  });
});

describe('previewTrim', () => {
  it('removes nothing when the count is not lower than the chain', () => {
    expect(previewTrim([auto(2), auto(3)], 2)).toEqual({
      removed: 0,
      kept: 0,
    });
  });

  it('removes the latest empty cycles beyond the count', () => {
    expect(previewTrim([auto(2), auto(3), auto(4), auto(5)], 2)).toEqual({
      removed: 2,
      kept: 0,
    });
  });

  it('stops at the first cycle it must keep and keeps the ones before it', () => {
    const chain = [auto(2), auto(3), auto(4, { name: 'Launch' }), auto(5)];

    expect(previewTrim(chain, 1)).toEqual({ removed: 1, kept: 2 });
  });

  it('leaves cancelled cycles out of the count', () => {
    expect(previewTrim([auto(2), auto(3, { cancelled: true })], 1)).toEqual({
      removed: 0,
      kept: 0,
    });
  });
});

describe('trimSentence', () => {
  it('reads empty when nothing changes', () => {
    expect(trimSentence(0, 0, true)).toBe('');
  });

  it('phrases the preview and the result', () => {
    expect(trimSentence(1, 0, true)).toBe(
      'Saving removes 1 empty upcoming cycle.'
    );
    expect(trimSentence(2, 2, false)).toBe(
      'Removed 2 empty upcoming cycles. 2 upcoming cycles beyond the new count stay because they, or a later cycle, hold issues or were changed by hand.'
    );
  });
});
