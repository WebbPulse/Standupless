/**
 * The cycles band's arithmetic. Covers that cycles sort by start and share
 * one lane until two overlap, that a cycle whose dates do not read is left
 * off, that dates read as short month and day, and that the arrow, Home and
 * End keys pick a neighbouring bar held at the ends.
 */

import { describe, expect, it } from 'vitest';
import type { CycleRead } from '../types/Api';
import {
  cycleBandDates,
  cycleBandLayout,
  cycleBarDays,
  neighbourIndex,
} from './cycleTimeline';
import { dayNumber } from './timeline';

/** A cycle over the given days, with nothing else that matters here. */
const cycle = (id: string, start: string, end: string): CycleRead => ({
  cycle_id: id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  name: id,
  start_date: start,
  end_date: end,
  goal: null,
  cancelled: false,
  status: 'upcoming',
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});

describe('cycleBandLayout', () => {
  it('puts back to back cycles in one lane, oldest first', () => {
    const layout = cycleBandLayout([
      cycle('b', '2026-10-15', '2026-10-28'),
      cycle('a', '2026-10-01', '2026-10-14'),
    ]);
    expect(layout.lanes).toBe(1);
    expect(layout.bars.map((bar) => [bar.cycle.cycle_id, bar.lane])).toEqual([
      ['a', 0],
      ['b', 0],
    ]);
  });

  it('stacks overlapping cycles and reuses the first lane that frees up', () => {
    const layout = cycleBandLayout([
      cycle('a', '2026-10-01', '2026-10-14'),
      cycle('b', '2026-10-10', '2026-10-20'),
      cycle('c', '2026-10-15', '2026-10-28'),
    ]);
    expect(layout.lanes).toBe(2);
    expect(layout.bars.map((bar) => bar.lane)).toEqual([0, 1, 0]);
  });

  it('leaves off a cycle whose dates do not read and keeps one lane when empty', () => {
    expect(cycleBandLayout([cycle('x', 'soon', '2026-10-14')]).bars).toEqual(
      []
    );
    expect(cycleBandLayout([]).lanes).toBe(1);
  });
});

describe('cycleBarDays', () => {
  it('covers both ends of the cycle', () => {
    expect(cycleBarDays(cycle('a', '2026-10-01', '2026-10-14'))).toEqual({
      start: dayNumber('2026-10-01'),
      end: dayNumber('2026-10-14'),
    });
  });
});

describe('cycleBandDates', () => {
  it('reads as short month and day', () => {
    expect(
      cycleBandDates({ start_date: '2026-10-27', end_date: '2026-11-09' })
    ).toBe('Oct 27 to Nov 9');
  });
});

describe('neighbourIndex', () => {
  it('steps with the arrows and jumps with Home and End, held at the ends', () => {
    expect(neighbourIndex('ArrowLeft', 0, 3)).toBe(0);
    expect(neighbourIndex('ArrowRight', 0, 3)).toBe(1);
    expect(neighbourIndex('ArrowRight', 2, 3)).toBe(2);
    expect(neighbourIndex('Home', 2, 3)).toBe(0);
    expect(neighbourIndex('End', 0, 3)).toBe(2);
    expect(neighbourIndex('j', 0, 3)).toBeNull();
    expect(neighbourIndex('ArrowLeft', 0, 0)).toBeNull();
  });
});
