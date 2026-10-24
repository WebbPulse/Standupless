/**
 * The planning arithmetic: grouping projects and issues in list order, the
 * days of a cycle, and the burn-up read off the issues as they are now.
 */

import { describe, expect, it } from 'vitest';
import type {
  CycleHistoryPoint,
  IssueRead,
  ProjectHistoryRead,
  ProjectRead,
  StatusRead,
  TeamRead,
  VelocityRead,
} from '../types/Api';
import {
  burnUpSeries,
  canEditProject,
  capacityGuidance,
  historySeries,
  projectCompletion,
  projectionLabel,
  velocityMeasure,
  categoryCounts,
  daysBetween,
  groupIssuesByCategory,
  groupProjectsByStatus,
  projectGraphRange,
  countEach,
  issueWeight,
  pointWeigher,
  projectHistoryGraph,
  projectionNote,
} from './planningModel';

const statuses: StatusRead[] = [
  { id: 'todo', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'doing', name: 'Doing', category: 'started', position: 1 },
  { id: 'done', name: 'Done', category: 'completed', position: 2 },
  { id: 'dropped', name: 'Dropped', category: 'cancelled', position: 3 },
];

const issue = (
  id: string,
  statusId: string,
  createdAt: string,
  updatedAt: string
): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: id,
  body: null,
  status_id: statusId,
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: 'cyc-1',
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: `${createdAt}T09:00:00Z`,
  updated_at: `${updatedAt}T09:00:00Z`,
});

const project = (id: string, status: ProjectRead['status']): ProjectRead => ({
  project_id: id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: null,
  name: id,
  description: null,
  target_date: null,
  status,
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'user-1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
});

describe('groupProjectsByStatus', () => {
  it('runs in list order and drops empty statuses', () => {
    const groups = groupProjectsByStatus([
      project('a', 'planned'),
      project('b', 'in_progress'),
      project('c', 'planned'),
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      'in_progress',
      'planned',
    ]);
    expect(groups[1]?.rows.map((row) => row.project_id)).toEqual(['a', 'c']);
  });
});

describe('groupIssuesByCategory', () => {
  it('files an unknown status with the backlog', () => {
    const groups = groupIssuesByCategory(
      [
        issue('1', 'doing', '2026-09-01', '2026-09-01'),
        issue('2', 'mystery', '2026-09-01', '2026-09-01'),
      ],
      statuses
    );
    expect(groups.map((group) => group.key)).toEqual(['started', 'backlog']);
  });
});

describe('categoryCounts', () => {
  it('counts each category', () => {
    const counts = categoryCounts(
      [
        issue('1', 'done', '2026-09-01', '2026-09-01'),
        issue('2', 'done', '2026-09-01', '2026-09-01'),
        issue('3', 'todo', '2026-09-01', '2026-09-01'),
      ],
      statuses
    );
    expect(counts.completed).toBe(2);
    expect(counts.unstarted).toBe(1);
    expect(counts.started).toBe(0);
  });
});

describe('canEditProject', () => {
  it('lets a guest edit only with a role on one of its teams', () => {
    const row = { team_ids: ['team-1'] };
    const team = {
      id: 'team-1',
      workspace_id: 'ws-1',
      name: 'Engine',
      key_prefix: 'ENG',
      description: null,
      estimate_scale: 'off' as const,
      created_at: '',
      updated_at: '',
    };
    expect(canEditProject('guest', row, [team])).toBe(false);
    expect(canEditProject('guest', row, [{ ...team, role: 'member' }])).toBe(
      true
    );
    expect(canEditProject('member', row, [])).toBe(true);
  });
});

describe('daysBetween', () => {
  it('lists both ends', () => {
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('is empty when the end comes first', () => {
    expect(daysBetween('2026-10-02', '2026-09-29')).toEqual([]);
  });
});

describe('burnUpSeries', () => {
  const issues = [
    issue('1', 'done', '2026-08-20', '2026-09-03'),
    issue('2', 'doing', '2026-09-02', '2026-09-02'),
    issue('3', 'todo', '2026-09-04', '2026-09-04'),
    issue('4', 'dropped', '2026-09-01', '2026-09-01'),
  ];

  it('stops at today and leaves cancelled issues out of scope', () => {
    const points = burnUpSeries(
      issues,
      statuses,
      '2026-09-01',
      '2026-09-14',
      '2026-09-04'
    );
    expect(points.map((point) => point.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
    expect(points.map((point) => point.scope)).toEqual([1, 2, 2, 3]);
    expect(points.map((point) => point.started)).toEqual([0, 1, 2, 2]);
    expect(points.map((point) => point.completed)).toEqual([0, 0, 1, 1]);
  });

  it('ends at the cycle end once the cycle is over', () => {
    const points = burnUpSeries(
      issues,
      statuses,
      '2026-09-01',
      '2026-09-03',
      '2026-09-20'
    );
    expect(points).toHaveLength(3);
  });
});

describe('historySeries', () => {
  const days = [
    {
      date: '2026-09-01',
      scope: 3,
      started: 1,
      completed: 0,
      scope_points: 8,
      started_points: 2,
      completed_points: 0,
    },
  ];

  it('reads either measure off the recorded days', () => {
    expect(historySeries(days, 'issues')).toEqual([
      { date: '2026-09-01', scope: 3, started: 1, completed: 0 },
    ]);
    expect(historySeries(days, 'points')).toEqual([
      { date: '2026-09-01', scope: 8, started: 2, completed: 0 },
    ]);
  });
});

describe('projectCompletion', () => {
  const point = (completed: number, scope = 10) => ({
    date: 'd',
    scope,
    started: completed,
    completed,
  });

  it('extends the pace so far to the last day', () => {
    expect(projectCompletion([point(0), point(1), point(2)], 10)).toBe(6.7);
  });

  it('caps at the scope', () => {
    expect(projectCompletion([point(3), point(5), point(6)], 10)).toBe(10);
  });

  it('draws nothing on too little to go on', () => {
    expect(projectCompletion([point(1), point(2)], 10)).toBeNull();
    expect(projectCompletion([point(0), point(0), point(0)], 10)).toBeNull();
    expect(projectCompletion([point(1), point(2), point(3)], 3)).toBeNull();
    expect(projectCompletion([], 10)).toBeNull();
  });

  it('reads in words', () => {
    expect(projectionLabel(10, 10, 'issues')).toBe(
      'On pace to finish the scope'
    );
    expect(projectionLabel(6.7, 10, 'points')).toBe(
      'On pace for 7 of 10 points'
    );
  });
});

describe('capacityGuidance', () => {
  const velocity: VelocityRead = {
    team_id: 't',
    estimate_scale: 'linear',
    cycles: [
      {
        cycle_id: 'a',
        name: 'A',
        start_date: '2026-08-01',
        end_date: '2026-08-14',
        completed_issues: 3,
        completed_points: 7,
        scope_issues: 4,
        scope_points: 9,
        carried_out: 1,
        carried_out_points: 2,
      },
    ],
    average_points: 7,
    average_issues: 3,
    upcoming: {
      cycle_id: 'b',
      name: 'B',
      status: 'upcoming',
      start_date: '2026-09-01',
      end_date: '2026-09-14',
      scope_issues: 5,
      scope_points: 6,
      carried_in: 1,
      carried_in_points: 2,
    },
  };

  it('reads in points when the team estimates and has estimated history', () => {
    expect(velocityMeasure(velocity)).toBe('points');
    expect(capacityGuidance(velocity)).toEqual({
      measure: 'points',
      average: 7,
      planned: 6,
      carriedIn: 2,
      delta: -1,
    });
  });

  it('reads in issues when the team does not estimate', () => {
    const off = { ...velocity, estimate_scale: 'off' };
    expect(velocityMeasure(off)).toBe('issues');
    expect(capacityGuidance(off)?.delta).toBe(2);
  });

  it('gives nothing without a cycle to plan or a closed one to compare', () => {
    expect(capacityGuidance({ ...velocity, upcoming: null })).toBeNull();
    expect(capacityGuidance({ ...velocity, cycles: [] })).toBeNull();
  });
});

describe('projectGraphRange', () => {
  const created = { created_at: '2026-09-10T12:00:00Z' };

  it('opens on the start date and runs to a target still ahead', () => {
    expect(
      projectGraphRange(
        { ...created, start_date: '2026-09-12', target_date: '2026-10-30' },
        [],
        '2026-09-26'
      )
    ).toEqual({ start: '2026-09-12', end: '2026-10-30' });
  });

  it('opens on the earliest issue when there is no start date', () => {
    expect(
      projectGraphRange(
        { ...created, start_date: null, target_date: null },
        [{ created_at: '2026-09-02T08:00:00Z' }],
        '2026-09-26'
      )
    ).toEqual({ start: '2026-09-02', end: '2026-09-26' });
  });

  it('runs to today once the target has passed', () => {
    expect(
      projectGraphRange(
        { ...created, start_date: null, target_date: '2026-09-20' },
        [],
        '2026-09-26'
      )
    ).toEqual({ start: '2026-09-10', end: '2026-09-26' });
  });

  it('has nothing to draw before the project starts', () => {
    expect(
      projectGraphRange(
        { ...created, start_date: '2026-10-01', target_date: null },
        [],
        '2026-09-26'
      )
    ).toBeNull();
  });
});

const team = (
  id: string,
  scale: TeamRead['estimate_scale'],
  countUnestimated = false
): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name: id,
  key_prefix: id.toUpperCase(),
  description: null,
  estimate_scale: scale,
  estimate_count_unestimated: countUnestimated,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
});

const sized = (
  id: string,
  statusId: string,
  estimate: string | null,
  teamId = 'team-1'
): IssueRead => ({
  ...issue(id, statusId, '2026-09-01', '2026-09-02'),
  estimate,
  team_id: teamId,
});

describe('issueWeight', () => {
  it('weighs sizes, numbers and unestimated issues on the team scale', () => {
    expect(issueWeight('L', team('t', 'tshirt'))).toBe(5);
    expect(issueWeight('XL', team('t', 'tshirt'))).toBe(8);
    expect(issueWeight('8', team('t', 'fibonacci'))).toBe(8);
    expect(issueWeight(null, team('t', 'tshirt'))).toBe(0);
    expect(issueWeight(null, team('t', 'tshirt', true))).toBe(1);
  });

  it('weighs every issue as one on a team with estimates off', () => {
    expect(issueWeight('XL', team('t', 'off'))).toBe(1);
    expect(issueWeight(null, team('t', 'off'))).toBe(1);
    expect(issueWeight('M', undefined)).toBe(1);
  });
});

describe('weighted progress', () => {
  const teams = [team('team-1', 'tshirt'), team('team-2', 'linear')];
  const issues = [
    sized('1', 'done', 'L'),
    sized('2', 'doing', 'M'),
    sized('3', 'todo', null),
    sized('4', 'todo', '4', 'team-2'),
  ];

  it('sums mixed sizes across teams on each team scale', () => {
    const counts = categoryCounts(issues, statuses, pointWeigher(teams));
    expect(counts.completed).toBe(5);
    expect(counts.started).toBe(3);
    expect(counts.unstarted).toBe(4);
  });

  it('falls back to one per issue when counting', () => {
    const counts = categoryCounts(issues, statuses, countEach);
    expect(counts.unstarted).toBe(2);
  });

  it('draws the burn-up in points', () => {
    const points = burnUpSeries(
      issues,
      statuses,
      '2026-09-01',
      '2026-09-02',
      '2026-09-02',
      pointWeigher(teams)
    );
    expect(points.map((point) => point.scope)).toEqual([12, 12]);
    expect(points.map((point) => point.started)).toEqual([0, 8]);
    expect(points.map((point) => point.completed)).toEqual([0, 5]);
  });
});

/** One recorded project day in issues, points mirroring the counts. */
const recordedDay = (
  date: string,
  scope: number,
  completed: number
): CycleHistoryPoint => ({
  date,
  scope,
  started: completed,
  completed,
  scope_points: scope * 2,
  started_points: completed * 2,
  completed_points: completed * 2,
});

/** A project history ending today, 2026-03-05, with a projection. */
const recorded = (
  overrides: Partial<ProjectHistoryRead> = {}
): ProjectHistoryRead => ({
  project_id: 'prj-1',
  start_date: '2026-03-01',
  target_date: '2026-03-09',
  today: '2026-03-05',
  measure: 'issues',
  recorded_since: '2026-03-02',
  days: [1, 2, 3, 4, 5].map((day) =>
    recordedDay(`2026-03-0${String(day)}`, 10, day - 1)
  ),
  projection: {
    rate_per_day: 1,
    expected_date: '2026-03-11',
    days_past_target: 2,
  },
  ...overrides,
});

describe('projectHistoryGraph', () => {
  it('falls back while nothing is recorded or the scope was always empty', () => {
    expect(projectHistoryGraph(recorded({ recorded_since: null }))).toBeNull();
    expect(
      projectHistoryGraph(recorded({ days: [recordedDay('2026-03-05', 0, 0)] }))
    ).toBeNull();
  });

  it('runs to the projected finish past the target and marks the target', () => {
    const graph = projectHistoryGraph(recorded());

    expect(graph?.points).toHaveLength(5);
    expect(graph?.days[0]).toBe('2026-03-01');
    expect(graph?.days[graph.days.length - 1]).toBe('2026-03-11');
    expect(graph?.targetDate).toBe('2026-03-09');
    expect(graph?.forecast).toEqual({ date: '2026-03-11', value: 10 });
  });

  it('runs to the target when the finish lands before it', () => {
    const graph = projectHistoryGraph(
      recorded({
        target_date: '2026-03-20',
        projection: {
          rate_per_day: 2,
          expected_date: '2026-03-08',
          days_past_target: -12,
        },
      })
    );

    expect(graph?.days[graph.days.length - 1]).toBe('2026-03-20');
    expect(graph?.forecast).toEqual({ date: '2026-03-08', value: 10 });
  });

  it('projects to the target without a finish in sight, capped at scope', () => {
    const graph = projectHistoryGraph(
      recorded({
        projection: {
          rate_per_day: 0.5,
          expected_date: null,
          days_past_target: null,
        },
      })
    );

    expect(graph?.forecast).toEqual({ date: '2026-03-09', value: 6 });
  });

  it('draws no forecast for a stalled project and reads points in points', () => {
    const graph = projectHistoryGraph(
      recorded({
        measure: 'points',
        target_date: null,
        projection: {
          rate_per_day: 0,
          expected_date: null,
          days_past_target: null,
        },
      })
    );

    expect(graph?.forecast).toBeNull();
    expect(graph?.targetDate).toBeNull();
    expect(graph?.days[graph.days.length - 1]).toBe('2026-03-05');
    expect(graph?.points[4]?.completed).toBe(8);
  });

  it('leaves out a finish further away than the horizon', () => {
    const graph = projectHistoryGraph(
      recorded({
        target_date: null,
        projection: {
          rate_per_day: 0.01,
          expected_date: '2027-12-01',
          days_past_target: null,
        },
      })
    );

    expect(graph?.days[graph.days.length - 1]).toBe('2026-03-05');
    expect(graph?.forecast).toBeNull();
  });
});

describe('projectionNote', () => {
  const day = (value: string): string => value;

  it('says how far the finish lands from the target', () => {
    expect(
      projectionNote(
        { rate_per_day: 1, expected_date: '2026-03-11', days_past_target: 2 },
        day
      )
    ).toEqual({
      text: 'Projected to finish 2026-03-11, 2 days after the target.',
      late: true,
    });
    expect(
      projectionNote(
        { rate_per_day: 1, expected_date: '2026-03-08', days_past_target: -1 },
        day
      )?.text
    ).toBe('Projected to finish 2026-03-08, 1 day before the target.');
    expect(
      projectionNote(
        { rate_per_day: 1, expected_date: '2026-03-09', days_past_target: 0 },
        day
      )?.text
    ).toBe('Projected to finish 2026-03-09, on the target date.');
    expect(
      projectionNote(
        {
          rate_per_day: 1,
          expected_date: '2026-03-09',
          days_past_target: null,
        },
        day
      )?.text
    ).toBe('Projected to finish 2026-03-09.');
  });

  it('explains a missing finish and reads nothing without a projection', () => {
    expect(
      projectionNote(
        { rate_per_day: 0, expected_date: null, days_past_target: null },
        day
      )?.text
    ).toBe(
      'No work was completed in the last two weeks, so there is no projected finish yet.'
    );
    expect(
      projectionNote(
        { rate_per_day: 0.01, expected_date: null, days_past_target: null },
        day
      )?.late
    ).toBe(true);
    expect(projectionNote(null, day)).toBeNull();
  });
});
