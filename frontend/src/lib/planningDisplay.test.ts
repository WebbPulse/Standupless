/**
 * How a planning row's counts read. The completion percentage is the one piece
 * of arithmetic this application does on a server number, so it is pinned:
 * cancelled work is out of the denominator, which is what lets a finished
 * cycle reach 100 rather than stalling below it.
 */

import { describe, expect, it } from 'vitest';
import {
  CYCLE_STATUSES,
  CYCLE_STATUS_LABELS,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  completionPercent,
  countsLabel,
  cycleDatesLabel,
  dateLabel,
} from './planningDisplay';
import type { RollupCounts } from '../types/Api';

const counts = (over: Partial<RollupCounts> = {}): RollupCounts => ({
  todo: 0,
  in_progress: 0,
  done: 0,
  cancelled: 0,
  total: 0,
  ...over,
});

describe('status vocabularies', () => {
  it('names every cycle status the contract allows', () => {
    expect(CYCLE_STATUSES).toEqual([
      'upcoming',
      'active',
      'completed',
      'cancelled',
    ]);
    for (const status of CYCLE_STATUSES) {
      expect(CYCLE_STATUS_LABELS[status]).not.toBe('');
    }
  });

  it('names every project status the contract allows', () => {
    expect(PROJECT_STATUSES).toEqual([
      'backlog',
      'planned',
      'in_progress',
      'paused',
      'completed',
      'canceled',
    ]);
    for (const status of PROJECT_STATUSES) {
      expect(PROJECT_STATUS_LABELS[status]).not.toBe('');
    }
  });
});

describe('counts', () => {
  it('says so plainly when nothing is planned into the row', () => {
    expect(countsLabel(counts())).toBe('No issues');
  });

  it('names the three live buckets and leaves a zero cancelled out', () => {
    expect(
      countsLabel(counts({ todo: 1, in_progress: 2, done: 3, total: 6 }))
    ).toBe('6 issues: 3 done, 2 in progress, 1 to do');
  });

  it('names cancelled work once there is some', () => {
    expect(
      countsLabel(counts({ todo: 1, done: 1, cancelled: 2, total: 4 }))
    ).toContain('2 cancelled');
  });
});

describe('completion', () => {
  it('is zero on an empty row rather than dividing by nothing', () => {
    expect(completionPercent(counts())).toBe(0);
  });

  it('reaches 100 when every live issue is done', () => {
    expect(completionPercent(counts({ done: 3, total: 3 }))).toBe(100);
  });

  it('leaves cancelled work out of the denominator', () => {
    expect(completionPercent(counts({ done: 2, cancelled: 2, total: 4 }))).toBe(
      100
    );
  });

  it('is zero when every issue was cancelled, since none is outstanding', () => {
    expect(completionPercent(counts({ cancelled: 3, total: 3 }))).toBe(0);
  });

  it('rounds to a whole percent', () => {
    expect(completionPercent(counts({ done: 1, todo: 2, total: 3 }))).toBe(33);
  });
});

describe('dates', () => {
  it('names the absence rather than drawing an empty cell', () => {
    expect(dateLabel(null, 'No target date')).toBe('No target date');
    expect(dateLabel('', 'No target date')).toBe('No target date');
  });

  it('shows a date it was given', () => {
    expect(dateLabel('2026-10-01', 'No target date')).toBe('2026-10-01');
  });

  it('reads a cycle as the span between its two dates', () => {
    expect(cycleDatesLabel('2026-09-01', '2026-09-14')).toBe(
      '2026-09-01 to 2026-09-14'
    );
  });
});
