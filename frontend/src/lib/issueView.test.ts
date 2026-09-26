/**
 * The view state and grouping helpers behind the issue list and board:
 * reading and writing the URL, the query a state runs, round trips through
 * a saved view, grouping, ordering and the changes a drag makes.
 */

import { describe, expect, it } from 'vitest';
import { NONE, type OrderedIssueRead } from '../api/issues';
import type { SavedViewDisplayRead } from '../api/views';
import {
  changeIsNoop,
  applyChange,
  defaultViewState,
  groupIssues,
  moveChange,
  orderKeyAt,
  parseViewState,
  sameViewState,
  sortIssues,
  stateToViewBody,
  toggleFilterValue,
  viewScope,
  viewStateQuery,
  viewToState,
  writeViewState,
  type IssueContext,
  type ViewState,
} from './issueView';

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

/** Two teams that share a Todo status by name and a bug label by name. */
const context: IssueContext = {
  statuses: [
    {
      id: 'st-todo',
      name: 'Todo',
      category: 'unstarted',
      position: 0,
      team_id: 'team-1',
    },
    {
      id: 'st-done',
      name: 'Done',
      category: 'completed',
      position: 1,
      team_id: 'team-1',
    },
    {
      id: 'st-todo-2',
      name: 'Todo',
      category: 'unstarted',
      position: 0,
      team_id: 'team-2',
    },
  ],
  labels: [
    { id: 'lb-bug', name: 'Bug', color: '#ef4444', team_id: 'team-1' },
    { id: 'lb-ui', name: 'UI', color: '#3b82f6', team_id: 'team-1' },
    { id: 'lb-bug-2', name: 'bug', color: '#ef4444', team_id: 'team-2' },
  ],
  people: [
    { user_id: 'user-1', email: 'me@example.com', display_name: 'Me' },
    { user_id: 'user-2', email: 'ada@example.com', display_name: 'Ada' },
  ],
  projects: [],
  cycles: [],
  currentUserId: 'user-1',
};

const base = defaultViewState('list');

describe('the URL', () => {
  it('writes nothing for the base state', () => {
    expect(writeViewState(base, base).toString()).toBe('');
  });

  it('round trips filters and display through the address', () => {
    const state: ViewState = {
      ...base,
      filters: [
        { field: 'priority', op: 'is', values: ['high', 'urgent'] },
        { field: 'assignee', op: 'is_not', values: [NONE] },
      ],
      groupBy: 'assignee',
      subGroupBy: 'priority',
      ordering: 'manual',
      visible: ['labels'],
      layout: 'board',
      showEmpty: false,
    };
    const params = writeViewState(state, base);

    expect(params.getAll('f')).toEqual([
      'priority.is:high,urgent',
      'assignee.not:none',
    ]);
    expect(sameViewState(parseViewState(params, base), state)).toBe(true);
  });

  it('keeps parameters it does not own', () => {
    const keep = new URLSearchParams('peek=ENG-1&group=priority');
    const params = writeViewState(base, base, keep);

    expect(params.toString()).toBe('peek=ENG-1');
  });

  it('holds an emptied filter list over a base that has filters', () => {
    const filtered: ViewState = {
      ...base,
      filters: [{ field: 'priority', op: 'is', values: ['high'] }],
    };
    const params = writeViewState(base, filtered);

    expect(parseViewState(params, filtered).filters).toEqual([]);
  });

  it('drops malformed clauses and a sub-grouping equal to the grouping', () => {
    const state = parseViewState(
      new URLSearchParams(
        'f=nope.is:x&f=priority.is:&group=priority&sub=priority'
      ),
      base
    );

    expect(state.filters).toEqual([]);
    expect(state.subGroupBy).toBe('none');
  });

  it('shows empty groups by default on the board only', () => {
    expect(
      parseViewState(new URLSearchParams('layout=board'), base).showEmpty
    ).toBe(true);
    expect(parseViewState(new URLSearchParams(''), base).showEmpty).toBe(false);
  });
});

describe('the query', () => {
  it('turns clauses into list parameters over the scope', () => {
    const state: ViewState = {
      ...base,
      filters: [
        { field: 'status', op: 'is', values: ['st-todo', 'st-todo-2'] },
        { field: 'label', op: 'is_not', values: ['lb-bug'] },
      ],
    };

    expect(viewStateQuery(state, { team_id: 'team-1' })).toEqual({
      team_id: 'team-1',
      status_id: ['st-todo', 'st-todo-2'],
      label_id_not: ['lb-bug'],
      sort: 'priority_desc',
    });
  });

  it('toggles a value on and off a clause', () => {
    const on = toggleFilterValue([], 'priority', 'high');
    expect(on).toEqual([{ field: 'priority', op: 'is', values: ['high'] }]);
    expect(toggleFilterValue(on, 'priority', 'high')).toEqual([]);
  });
});

describe('saved views', () => {
  it('saves a state and reads it back the same', () => {
    const state: ViewState = {
      ...base,
      filters: [{ field: 'assignee', op: 'is', values: ['user-2'] }],
      groupBy: 'priority',
      layout: 'board',
      showEmpty: true,
    };
    const body = stateToViewBody(state, 'Ada', { team_id: 'team-1' }, 'team-1');

    expect(body).toMatchObject({
      name: 'Ada',
      kind: 'board',
      team_id: 'team-1',
      group_by: 'priority',
      sub_group_by: null,
      layout: 'board',
    });
    const view = {
      view_id: 'v-1',
      ...body,
      team_id: 'team-1',
    } as unknown as SavedViewDisplayRead;

    expect(sameViewState(viewToState(view), state)).toBe(true);
    expect(viewScope(view.filter)).toEqual({ team_id: 'team-1' });
  });
});

describe('grouping', () => {
  it('groups like named statuses across teams under one header', () => {
    const groups = groupIssues(
      [
        issue({ id: 'a', status_id: 'st-todo' }),
        issue({ id: 'b', team_id: 'team-2', status_id: 'st-todo-2' }),
        issue({ id: 'c', status_id: 'st-done' }),
      ],
      'status',
      context,
      false
    );

    expect(groups.map((group) => [group.label, group.issues.length])).toEqual([
      ['Todo', 2],
      ['Done', 1],
    ]);
  });

  it('keeps empty groups only when asked', () => {
    const groups = groupIssues([issue()], 'assignee', context, true);

    expect(groups.map((group) => group.label)).toEqual([
      'No assignee',
      'Me',
      'Ada',
    ]);
  });

  it('places an issue under each of its labels', () => {
    const groups = groupIssues(
      [issue({ label_ids: ['lb-bug', 'lb-ui'] })],
      'label',
      context,
      false
    );

    expect(groups.map((group) => group.label.toLowerCase())).toEqual([
      'bug',
      'ui',
    ]);
  });

  it('sorts by priority, keeping ties in order', () => {
    const sorted = sortIssues(
      [
        issue({ id: 'low', priority: 'low' }),
        issue({ id: 'u1', priority: 'urgent' }),
        issue({ id: 'u2', priority: 'urgent' }),
      ],
      'priority_desc'
    );

    expect(sorted.map((row) => row.id)).toEqual(['u1', 'u2', 'low']);
  });
});

describe('moving and ordering', () => {
  it('moves to the like named status in the issue own team', () => {
    const moving = issue({ team_id: 'team-2', status_id: 'st-other' });

    expect(
      moveChange(moving, 'status', 'completed:done', 'unstarted:todo', context)
    ).toEqual({ status_id: 'st-todo-2' });
    expect(
      moveChange(moving, 'status', 'unstarted:todo', 'completed:done', context)
    ).toBeNull();
  });

  it('swaps one label for another and keeps the rest', () => {
    const moving = issue({ label_ids: ['lb-bug', 'lb-ui'] });
    const change = moveChange(moving, 'label', 'bug', 'ui', context);

    expect(change).toEqual({
      add_label_ids: ['lb-ui'],
      remove_label_ids: ['lb-bug'],
    });
    expect(applyChange(moving, change ?? {}).label_ids).toEqual(['lb-ui']);
  });

  it('clears the assignee when moved to No assignee', () => {
    expect(
      moveChange(
        issue({ assignee_id: 'user-2' }),
        'assignee',
        'user-2',
        NONE,
        context
      )
    ).toEqual({ assignee_id: null });
  });

  it('knows a change that leaves the issue as it is', () => {
    expect(changeIsNoop(issue(), { priority: 'medium' })).toBe(true);
    expect(changeIsNoop(issue(), { priority: 'high' })).toBe(false);
  });

  it('orders a dropped card between its neighbours', () => {
    const column = [
      issue({ id: 'a', sort_order: 'a0' }),
      issue({ id: 'b', sort_order: 'a2' }),
      issue({ id: 'c', sort_order: 'a4' }),
    ];
    const key = orderKeyAt(column, 1, 'c');

    expect(key > 'a0' && key < 'a2').toBe(true);
    expect(orderKeyAt(column, 0, 'x') < 'a0').toBe(true);
    expect(orderKeyAt(column, 3, 'x') > 'a4').toBe(true);
  });
});
