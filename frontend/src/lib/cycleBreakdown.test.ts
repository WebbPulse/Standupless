/**
 * The cycle breakdown and title. Covers that each row counts its issues and
 * those done, that cancelled issues are left out, that like named labels of
 * two teams share one row, that the unset row sorts last, that priorities
 * keep their fixed order from urgent down to no priority, that a weigher sums
 * the rows in points, and that a cycle left with its generated name never
 * reads as the raw slug.
 */

import { describe, expect, it } from 'vitest';
import type { IssueRead, ProjectRead, StatusRead } from '../types/Api';
import {
  breakdownPercent,
  cycleBreakdown,
  cycleTitle,
  PRIORITY_ORDER,
} from './cycleBreakdown';
import type { IssueContext } from './issueView';

const statuses: StatusRead[] = [
  { id: 'todo', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'doing', name: 'Doing', category: 'started', position: 1 },
  { id: 'done', name: 'Done', category: 'completed', position: 2 },
  { id: 'dropped', name: 'Dropped', category: 'cancelled', position: 3 },
];

/** An issue in the cycle with the fields a breakdown reads. */
const issue = (
  id: string,
  status: string,
  fields: Partial<IssueRead> = {}
): IssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: id,
  body: null,
  status_id: status,
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
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  ...fields,
});

const context: Pick<IssueContext, 'labels' | 'people' | 'projects'> = {
  labels: [
    { id: 'bug-1', name: 'Bug', color: '#f00', team_id: 'team-1' },
    { id: 'bug-2', name: 'bug', color: '#f00', team_id: 'team-2' },
    { id: 'ui', name: 'UI', color: '#00f', team_id: 'team-1' },
  ],
  people: [
    {
      user_id: 'ada',
      email: 'ada@example.com',
      display_name: 'Ada',
      avatar_url: null,
    },
    {
      user_id: 'bo',
      email: 'bo@example.com',
      display_name: null,
      avatar_url: null,
    },
  ],
  projects: [{ project_id: 'p-1', name: 'Launch' } as ProjectRead],
};

const issues = [
  issue('1', 'done', { assignee_id: 'ada', label_ids: ['bug-1'] }),
  issue('2', 'doing', { assignee_id: 'ada', label_ids: ['bug-2', 'ui'] }),
  issue('3', 'todo', { project_id: 'p-1' }),
  issue('4', 'todo', { assignee_id: 'bo', project_id: 'p-1' }),
  issue('5', 'dropped', { assignee_id: 'bo', label_ids: ['ui'] }),
];

describe('cycleBreakdown', () => {
  it('counts each assignee with the unset row last', () => {
    expect(cycleBreakdown(issues, statuses, 'assignee', context)).toEqual([
      { id: 'ada', name: 'Ada', total: 2, completed: 1, started: 2 },
      { id: 'bo', name: 'bo@example.com', total: 1, completed: 0, started: 0 },
      { id: 'none', name: 'No assignee', total: 1, completed: 0, started: 0 },
    ]);
  });

  it('shares one row between like named labels and leaves cancelled out', () => {
    expect(cycleBreakdown(issues, statuses, 'label', context)).toEqual([
      { id: 'bug-1', name: 'Bug', total: 2, completed: 1, started: 2 },
      { id: 'ui', name: 'UI', total: 1, completed: 0, started: 1 },
      { id: 'none', name: 'No label', total: 2, completed: 0, started: 0 },
    ]);
  });

  it('names projects and counts the issues outside one', () => {
    expect(cycleBreakdown(issues, statuses, 'project', context)).toEqual([
      { id: 'p-1', name: 'Launch', total: 2, completed: 0, started: 0 },
      { id: 'none', name: 'No project', total: 2, completed: 1, started: 2 },
    ]);
  });

  it('orders priorities from urgent down to no priority', () => {
    const byPriority = [
      issue('1', 'todo', { priority: 'low' }),
      issue('2', 'done', { priority: 'urgent' }),
      issue('3', 'todo', { priority: 'low' }),
      issue('4', 'doing', { priority: 'high' }),
      issue('5', 'todo'),
      issue('6', 'done', { priority: 'medium' }),
      issue('7', 'dropped', { priority: 'urgent' }),
      issue('8', 'todo', { priority: 'urgent' }),
    ];
    expect(cycleBreakdown(byPriority, statuses, 'priority', context)).toEqual([
      { id: 'urgent', name: 'Urgent', total: 2, completed: 1, started: 1 },
      { id: 'high', name: 'High', total: 1, completed: 0, started: 1 },
      { id: 'medium', name: 'Medium', total: 1, completed: 1, started: 1 },
      { id: 'low', name: 'Low', total: 2, completed: 0, started: 0 },
      { id: 'none', name: 'No priority', total: 1, completed: 0, started: 0 },
    ]);
  });

  it('leaves out the priorities no issue holds', () => {
    expect(
      cycleBreakdown(
        [issue('1', 'todo', { priority: 'low' }), issue('2', 'done')],
        statuses,
        'priority',
        context
      ).map((row) => row.id)
    ).toEqual(['low', 'none']);
    expect(PRIORITY_ORDER).toEqual(['urgent', 'high', 'medium', 'low', 'none']);
  });

  it('sums each row by a weigher, so it reads in points', () => {
    const points = (row: IssueRead): number =>
      row.estimate === null ? 0 : Number(row.estimate);
    expect(
      cycleBreakdown(
        [
          issue('1', 'done', { assignee_id: 'ada', estimate: '3' }),
          issue('2', 'doing', { assignee_id: 'ada', estimate: '5' }),
          issue('3', 'todo', { assignee_id: 'bo', estimate: '2' }),
          issue('4', 'dropped', { assignee_id: 'bo', estimate: '8' }),
        ],
        statuses,
        'assignee',
        context,
        points
      )
    ).toEqual([
      { id: 'ada', name: 'Ada', total: 8, completed: 3, started: 8 },
      { id: 'bo', name: 'bo@example.com', total: 2, completed: 0, started: 0 },
    ]);
  });

  it('reads a row as a whole percent done', () => {
    expect(
      breakdownPercent({
        id: 'a',
        name: 'A',
        total: 3,
        completed: 1,
        started: 1,
      })
    ).toBe(33);
    expect(
      breakdownPercent({
        id: 'a',
        name: 'A',
        total: 0,
        completed: 0,
        started: 0,
      })
    ).toBe(0);
  });
});

describe('cycleTitle', () => {
  it('keeps a name someone gave the cycle', () => {
    expect(
      cycleTitle({ name: 'Sprint 4', number: 4, start_date: '2026-10-05' })
    ).toBe('Sprint 4');
  });

  it('reads a generated name as the cycle number', () => {
    expect(
      cycleTitle({ name: 'auto-20261005', number: 2, start_date: '2026-10-05' })
    ).toBe('Cycle 2');
  });

  it('reads a generated name without a number as its start', () => {
    expect(
      cycleTitle({ name: 'auto-20261005', start_date: '2026-10-05' })
    ).toBe('Cycle of Oct 5');
  });
});
