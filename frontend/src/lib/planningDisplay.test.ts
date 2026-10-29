/**
 * How a planning row's counts read. The completion percentage is the one piece
 * of arithmetic this application does on a server number, so it is pinned:
 * cancelled work is out of the denominator, which is what lets a finished
 * cycle reach 100 rather than stalling below it. A cycle picker offers the
 * current cycle first and reads each cycle as Current, Next or Upcoming.
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
  cycleOptionDetail,
  cyclePlace,
  dateLabel,
  measureUnit,
  pickerCycleOrder,
  progressLabel,
  progressMeasureOf,
  progressPercent,
  updateNudge,
} from './planningDisplay';
import type { CycleRead, RollupCounts } from '../types/Api';

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

describe('updateNudge', () => {
  const now = new Date('2026-09-26T12:00:00Z');

  it('asks for a first update on a live project', () => {
    expect(
      updateNudge({ status: 'in_progress', last_update_at: null }, now)
    ).toBe('No updates yet');
    expect(updateNudge({ status: 'planned' }, now)).toBe('No updates yet');
  });

  it('nudges once the latest update is more than two weeks old', () => {
    expect(
      updateNudge(
        { status: 'in_progress', last_update_at: '2026-09-10T12:00:00Z' },
        now
      )
    ).toBe('No update in 2 weeks');
    expect(
      updateNudge(
        { status: 'in_progress', last_update_at: '2026-09-20T12:00:00Z' },
        now
      )
    ).toBeNull();
  });

  it('reads the server due state before anything else', () => {
    expect(
      updateNudge(
        {
          status: 'backlog',
          last_update_at: '2026-09-25T12:00:00Z',
          update_due_state: 'due',
        },
        now
      )
    ).toBe('Update due');
    expect(
      updateNudge(
        {
          status: 'in_progress',
          last_update_at: null,
          update_due_state: 'overdue',
        },
        now
      )
    ).toBe('Update overdue');
    expect(
      updateNudge(
        {
          status: 'in_progress',
          last_update_at: '2026-09-01T12:00:00Z',
          update_due_state: 'upcoming',
        },
        now
      )
    ).toBeNull();
  });

  it('stays quiet on a project that is not planned or in progress', () => {
    for (const status of [
      'backlog',
      'paused',
      'completed',
      'canceled',
    ] as const) {
      expect(updateNudge({ status, last_update_at: null }, now)).toBeNull();
    }
  });
});

describe('measured progress', () => {
  const issues = counts({ todo: 2, done: 2, total: 4 });
  const points = counts({ todo: 1, in_progress: 3, done: 8, total: 12 });

  it('reads in points when the server measures in points', () => {
    const row = {
      counts: issues,
      measure: 'points' as const,
      progress: points,
    };
    expect(progressMeasureOf(row)).toBe('points');
    expect(progressPercent(row)).toBe(67);
    expect(progressLabel(row)).toBe('8 of 12 points');
  });

  it('falls back to issue counts when no team estimates', () => {
    const row = {
      counts: issues,
      measure: 'issues' as const,
      progress: issues,
    };
    expect(progressMeasureOf(row)).toBe('issues');
    expect(progressPercent(row)).toBe(50);
    expect(progressLabel(row)).toBe('2 of 4 issues');
  });

  it('reads an older response without a measure in issues', () => {
    expect(progressPercent({ counts: issues })).toBe(50);
    expect(progressMeasureOf({ counts: issues, measure: 'points' })).toBe(
      'issues'
    );
  });

  it('names the unit, singular for one', () => {
    expect(measureUnit('points', 1)).toBe('point');
    expect(measureUnit('points', 3)).toBe('points');
    expect(measureUnit('issues', 1)).toBe('issue');
  });
});

describe('the cycle picker', () => {
  const cycle = (
    id: string,
    status: CycleRead['status'],
    start: string,
    end: string,
    team = 'team-1'
  ): CycleRead =>
    ({
      cycle_id: id,
      team_id: team,
      status,
      start_date: start,
      end_date: end,
    }) as CycleRead;
  const later = cycle('c4', 'upcoming', '2026-11-02', '2026-11-15');
  const next = cycle('c3', 'upcoming', '2026-10-19', '2026-11-01');
  const current = cycle('c2', 'active', '2026-10-05', '2026-10-18');
  const done = cycle('c1', 'completed', '2026-09-21', '2026-10-04');
  const other = cycle('o1', 'upcoming', '2026-11-09', '2026-11-22', 'team-2');
  const all = [later, done, next, other, current];

  it('offers the current cycle first, then upcoming ones by start date', () => {
    expect(pickerCycleOrder(all).map((row) => row.cycle_id)).toEqual([
      'c2',
      'c3',
      'c4',
      'o1',
      'c1',
    ]);
  });

  it('reads each cycle by its place on its own team schedule', () => {
    expect(cyclePlace(current, all)).toBe('Current');
    expect(cyclePlace(next, all)).toBe('Next');
    expect(cyclePlace(later, all)).toBe('Upcoming');
    expect(cyclePlace(other, all)).toBe('Next');
    expect(cyclePlace(done, all)).toBe('Completed');
  });

  it('adds the dates after the place', () => {
    expect(cycleOptionDetail(next, all, new Date(2026, 9, 25))).toBe(
      'Next · Oct 19 to Nov 1'
    );
  });
});
