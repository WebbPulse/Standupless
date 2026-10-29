/**
 * The order completed by recency display option: closed rows sort after the
 * open ones, newest closed first, and the switch rides the URL, the list
 * query, saved views and team defaults.
 */

import { describe, expect, it } from 'vitest';
import type { OrderedIssueRead } from '../api/issues';
import type { SavedViewDisplayRead } from '../api/views';
import {
  defaultViewState,
  parseViewState,
  sameViewState,
  sortIssues,
  stateToViewBody,
  viewStateQuery,
  viewToState,
  writeViewState,
  type ViewState,
} from './issueView';
import { stateToTeamDisplay, teamDefaultState } from './teamDisplay';

/** An issue with the given fields over a plain default. */
const issue = (fields: Partial<OrderedIssueRead> = {}): OrderedIssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'st-todo',
  priority: 'medium',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  ...fields,
});

const ids = (rows: OrderedIssueRead[]): string[] => rows.map((row) => row.id);

const rows = [
  issue({
    id: 'old-urgent',
    priority: 'urgent',
    completed_at: '2026-10-01T00:00:00Z',
  }),
  issue({ id: 'open-low', priority: 'low' }),
  issue({
    id: 'new-low',
    priority: 'low',
    completed_at: '2026-10-20T00:00:00Z',
  }),
  issue({ id: 'open-high', priority: 'high' }),
  issue({
    id: 'mid-cancelled',
    priority: 'high',
    cancelled_at: '2026-10-10T00:00:00Z',
  }),
];

describe('ordering completed by recency', () => {
  it('leaves the main ordering alone when off', () => {
    expect(ids(sortIssues(rows, 'priority_desc'))).toEqual([
      'old-urgent',
      'open-high',
      'mid-cancelled',
      'open-low',
      'new-low',
    ]);
  });

  it('puts closed rows after open ones, newest closed first', () => {
    expect(
      ids(sortIssues(rows, 'priority_desc', { completedByRecency: true }))
    ).toEqual([
      'open-high',
      'open-low',
      'new-low',
      'mid-cancelled',
      'old-urgent',
    ]);
  });

  it('keeps closed rows newest first when the ordering is reversed', () => {
    expect(
      ids(
        sortIssues(rows, 'priority_desc', {
          completedByRecency: true,
          reverse: true,
        })
      )
    ).toEqual([
      'open-low',
      'open-high',
      'new-low',
      'mid-cancelled',
      'old-urgent',
    ]);
  });

  it('breaks a closed tie on the higher id', () => {
    const tied = [
      issue({ id: 'a', completed_at: '2026-10-05T00:00:00Z' }),
      issue({ id: 'b', completed_at: '2026-10-05T00:00:00Z' }),
    ];
    expect(
      ids(sortIssues(tied, 'created_desc', { completedByRecency: true }))
    ).toEqual(['b', 'a']);
  });
});

describe('the order completed by recency switch', () => {
  const base = defaultViewState('list');
  const recent: ViewState = { ...base, completedByRecency: true };

  it('starts off and rides the URL', () => {
    expect(base.completedByRecency).toBe(false);
    const params = writeViewState(recent, base);

    expect(params.get('recency')).toBe('1');
    expect(sameViewState(parseViewState(params, base), recent)).toBe(true);
    expect(writeViewState(base, base).has('recency')).toBe(false);
    expect(sameViewState(recent, base)).toBe(false);
    const off = writeViewState(base, recent);
    expect(off.get('recency')).toBe('0');
    expect(parseViewState(off, recent).completedByRecency).toBe(false);
  });

  it('asks the list route for it only when set', () => {
    expect(viewStateQuery(recent)).toMatchObject({
      completed_by_recency: true,
    });
    expect(viewStateQuery(base)).not.toHaveProperty('completed_by_recency');
  });

  it('saves on a view and reads back, older views reading off', () => {
    const body = stateToViewBody(recent, 'Latest done');

    expect(body).toMatchObject({ order_completed_by_recency: true });
    expect(body.filter).not.toHaveProperty('completed_by_recency');
    const view = {
      view_id: 'v-1',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead;

    expect(viewToState(view).completedByRecency).toBe(true);
    const older: Partial<SavedViewDisplayRead> = { ...view };
    delete older.order_completed_by_recency;
    expect(viewToState(older as SavedViewDisplayRead).completedByRecency).toBe(
      false
    );
  });

  it('round-trips through a team default', () => {
    const saved = stateToTeamDisplay(recent);

    expect(saved.order_completed_by_recency).toBe(true);
    expect(teamDefaultState('list', saved).completedByRecency).toBe(true);
    expect(teamDefaultState('list', {}).completedByRecency).toBe(false);
  });
});
