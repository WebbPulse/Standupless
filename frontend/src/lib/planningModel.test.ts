/**
 * The planning arithmetic: grouping projects and issues in list order, the
 * days of a cycle, and the burn-up read off the issues as they are now.
 */

import { describe, expect, it } from 'vitest';
import type { IssueRead, ProjectRead, StatusRead } from '../types/Api';
import {
  burnUpSeries,
  canEditProject,
  categoryCounts,
  daysBetween,
  groupIssuesByCategory,
  groupProjectsByStatus,
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
