/**
 * The planning arithmetic: grouping projects and issues in list order, the
 * days of a cycle, and the burn-up read off the issues as they are now.
 */

import { describe, expect, it } from 'vitest';
import type {
  IssueRead,
  ProjectRead,
  StatusRead,
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
