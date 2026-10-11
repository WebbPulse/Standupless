/**
 * The view state and grouping helpers behind the issue list and board:
 * reading and writing the URL, the query a state runs, round trips through
 * a saved view, grouping, ordering and the changes a drag makes.
 */

import { describe, expect, it } from 'vitest';
import { NONE, type OrderedIssueRead } from '../api/issues';
import type { SavedViewDisplayRead } from '../api/views';
import type { MilestoneRead } from '../types/Api';
import {
  changeIsNoop,
  applyChange,
  defaultViewState,
  fieldsFor,
  filterValuesFor,
  GROUP_FIELDS,
  groupIssues,
  matchesFilters,
  moveChange,
  narrowFilters,
  ORDERING_LABELS,
  ORDERINGS,
  orderKeyAt,
  parseViewState,
  sameViewState,
  sharedChange,
  shownIssues,
  sortIssues,
  stateToViewBody,
  toggleFilterValue,
  viewScope,
  viewStateQuery,
  viewToState,
  viewVisibility,
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

/** A milestone of project prj-1 with the given progress counts. */
const milestone = (
  id: string,
  name: string,
  sortOrder: string,
  done: number
): MilestoneRead => ({
  milestone_id: id,
  workspace_id: 'ws-1',
  project_id: 'prj-1',
  name,
  description: null,
  target_date: null,
  sort_order: sortOrder,
  counts: { todo: 4 - done, in_progress: 0, done, cancelled: 0, total: 4 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
});

/** The same teams inside project prj-1, which carries two milestones. */
const inProject: IssueContext = {
  ...context,
  milestones: [
    milestone('ms-2', 'Beta', 'X', 1),
    milestone('ms-1', 'Alpha', 'V', 2),
  ],
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

describe('view options', () => {
  it('keeps sub-issues and completed issues out of the address until hidden', () => {
    const hidden: ViewState = {
      ...base,
      showSubIssues: false,
      showCompleted: false,
    };
    const params = writeViewState(hidden, base);

    expect(params.toString()).toBe('subs=0&done=0');
    expect(sameViewState(parseViewState(params, base), hidden)).toBe(true);
  });

  it('leaves out sub-issues and closed issues when hidden', () => {
    const rows = [
      issue({ id: 'open' }),
      issue({ id: 'child', parent_id: 'open' }),
      issue({ id: 'closed', status_id: 'st-done' }),
    ];
    const ids = (state: Pick<ViewState, 'showSubIssues' | 'showCompleted'>) =>
      shownIssues(rows, state, context).map((row) => row.id);

    expect(ids({ showSubIssues: true, showCompleted: true })).toEqual([
      'open',
      'child',
      'closed',
    ]);
    expect(ids({ showSubIssues: false, showCompleted: true })).toEqual([
      'open',
      'closed',
    ]);
    expect(ids({ showSubIssues: true, showCompleted: false })).toEqual([
      'open',
      'child',
    ]);
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

  it('filters on SLA status and never sends an SLA exclusion', () => {
    const state: ViewState = {
      ...base,
      filters: [{ field: 'sla', op: 'is', values: ['at_risk', 'breached'] }],
    };

    expect(viewStateQuery(state)).toEqual({
      sla_status: ['at_risk', 'breached'],
      sort: 'priority_desc',
    });
    expect(
      parseViewState(new URLSearchParams('f=sla.not:breached'), base).filters
    ).toEqual([{ field: 'sla', op: 'is', values: ['breached'] }]);
    expect(
      viewStateQuery({
        ...base,
        filters: [{ field: 'sla', op: 'is_not', values: ['none'] }],
      })
    ).toEqual({ sla_status: ['none'], sort: 'priority_desc' });
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

  it('keeps the sub-issue and completed switches through a save', () => {
    const state: ViewState = {
      ...defaultViewState(),
      showSubIssues: false,
      showCompleted: false,
    };
    const body = stateToViewBody(state, 'Open work');

    expect(body).toMatchObject({
      show_sub_issues: false,
      show_completed: false,
    });
    const view = {
      view_id: 'v-2',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead;

    const restored = viewToState(view);
    expect(restored.showSubIssues).toBe(false);
    expect(restored.showCompleted).toBe(false);
    expect(sameViewState(restored, state)).toBe(true);
  });

  it('reads a view saved before the switches existed as showing both', () => {
    const view = {
      view_id: 'v-3',
      name: 'Old',
      kind: 'list',
      filter: {},
      sort: 'updated_desc',
      group_by: 'status',
      layout: 'list',
    } as unknown as SavedViewDisplayRead;

    const restored = viewToState(view);
    expect(restored.showSubIssues).toBe(true);
    expect(restored.showCompleted).toBe(true);
    expect(restored.showArchived).toBe(false);
  });

  it('asks the list for archived issues only when shown, and saves the switch', () => {
    const shown: ViewState = { ...defaultViewState(), showArchived: true };
    const params = writeViewState(shown, defaultViewState());

    expect(params.toString()).toBe('archived=1');
    expect(parseViewState(params, defaultViewState()).showArchived).toBe(true);
    expect(viewStateQuery(defaultViewState())).not.toHaveProperty(
      'include_archived'
    );
    expect(viewStateQuery(shown)).toMatchObject({ include_archived: true });

    const body = stateToViewBody(shown, 'Everything');
    expect(body.show_archived).toBe(true);
    expect(body.filter).not.toHaveProperty('include_archived');
    const restored = viewToState({
      view_id: 'v-4',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead);
    expect(sameViewState(restored, shown)).toBe(true);
  });
});

describe('the composer filters', () => {
  const composed: ViewState = {
    ...base,
    filters: [
      { field: 'creator', op: 'is_not', values: ['user-2'] },
      { field: 'team', op: 'is', values: ['team-1', 'team-2'] },
      { field: 'team', op: 'is_not', values: ['team-3'] },
      { field: 'created', op: 'after', values: ['2026-10-01'] },
      { field: 'due', op: 'before', values: ['2026-11-01'] },
    ],
  };

  it('sends team, creator and date clauses under their server keys', () => {
    expect(viewStateQuery(composed)).toEqual({
      team_id_in: ['team-1', 'team-2'],
      team_id_not: ['team-3'],
      creator_id_not: ['user-2'],
      created_after: '2026-10-01',
      due_before: '2026-11-01',
      sort: 'priority_desc',
    });
  });

  it('round trips the clauses through the URL and a saved view', () => {
    const params = writeViewState(composed, base);
    expect(sameViewState(parseViewState(params, base), composed)).toBe(true);

    const body = stateToViewBody(composed, 'Composed');
    const view = {
      view_id: 'v-9',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead;
    expect(sameViewState(viewToState(view), composed)).toBe(true);
  });

  it('drops a date clause whose value is not a day', () => {
    expect(
      parseViewState(new URLSearchParams('f=created.after:soon'), base).filters
    ).toEqual([]);
  });

  it('matches date bounds as exclusive days', () => {
    const made = issue({ created_at: '2026-10-05T12:00:00Z' });
    const after = (day: string) =>
      matchesFilters(made, [{ field: 'created', op: 'after', values: [day] }]);
    expect(after('2026-10-04')).toBe(true);
    expect(after('2026-10-05')).toBe(false);
    expect(
      matchesFilters(issue({ due_date: null }), [
        { field: 'due', op: 'before', values: ['2026-10-05'] },
      ])
    ).toBe(false);
  });

  it('marks a workspace view as shared and carries its look', () => {
    expect(
      stateToViewBody(base, 'Everyone', {}, undefined, {
        shared: true,
        look: { icon: 'bug', color: 'red', description: null },
      })
    ).toMatchObject({
      shared: true,
      icon: 'bug',
      color: 'red',
      description: null,
    });
    expect(
      stateToViewBody(base, 'Team', { team_id: 'team-1' }, 'team-1', {
        shared: true,
      })
    ).not.toHaveProperty('shared');
  });

  it('offers the team field only across more than one team', () => {
    const one = { milestones: [], teams: [{ id: 't-1', name: 'Engine' }] };
    const two = {
      milestones: [],
      teams: [
        { id: 't-1', name: 'Engine' },
        { id: 't-2', name: 'Design' },
      ],
    };
    expect(fieldsFor(['team', 'status'], one)).toEqual(['status']);
    expect(fieldsFor(['team', 'status'], two)).toEqual(['team', 'status']);
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

  it('sorts by SLA breach with no running SLA last', () => {
    const sorted = sortIssues(
      [
        issue({ id: 'none', sla_status: 'none', sla_breaches_at: null }),
        issue({
          id: 'later',
          sla_status: 'on_track',
          sla_breaches_at: '2026-10-20T00:00:00Z',
        }),
        issue({
          id: 'stopped',
          sla_status: 'none',
          sla_breaches_at: '2026-10-01T00:00:00Z',
        }),
        issue({
          id: 'breached',
          sla_status: 'breached',
          sla_breaches_at: '2026-10-02T00:00:00Z',
        }),
      ],
      'sla_asc'
    );

    expect(sorted.map((row) => row.id)).toEqual([
      'breached',
      'later',
      'none',
      'stopped',
    ]);
  });

  it('offers the SLA breach ordering in the display menu', () => {
    expect(ORDERINGS).toContain('sla_asc');
    expect(ORDERING_LABELS.sla_asc).toBe('SLA breach');
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

describe('milestones', () => {
  it('offers the milestone fields only inside a project', () => {
    expect(fieldsFor(GROUP_FIELDS, context)).not.toContain('milestone');
    expect(fieldsFor(GROUP_FIELDS, inProject)).toContain('milestone');
  });

  it('filters on the milestone id', () => {
    const state: ViewState = {
      ...base,
      filters: [{ field: 'milestone', op: 'is_not', values: ['ms-1'] }],
    };

    expect(viewStateQuery(state, { project_id: 'prj-1' })).toMatchObject({
      project_id: 'prj-1',
      project_milestone_id_not: ['ms-1'],
    });
  });

  it('groups in milestone order with progress, no milestone last', () => {
    const groups = groupIssues(
      [
        issue({ id: 'a', project_id: 'prj-1', project_milestone_id: 'ms-2' }),
        issue({ id: 'b', project_id: 'prj-1', project_milestone_id: 'gone' }),
      ],
      'milestone',
      inProject,
      true
    );

    expect(
      groups.map((group) => [group.label, group.progress, group.issues.length])
    ).toEqual([
      ['Alpha', 50, 0],
      ['Beta', 25, 1],
      ['No milestone', undefined, 1],
    ]);
  });

  it('moves between milestones and to none', () => {
    const moving = issue({ project_id: 'prj-1', project_milestone_id: 'ms-1' });

    expect(moveChange(moving, 'milestone', 'ms-1', 'ms-2', inProject)).toEqual({
      project_milestone_id: 'ms-2',
    });
    expect(moveChange(moving, 'milestone', 'ms-1', NONE, inProject)).toEqual({
      project_milestone_id: null,
    });
    expect(
      moveChange(
        issue({ project_id: 'prj-9' }),
        'milestone',
        NONE,
        'ms-2',
        inProject
      )
    ).toBeNull();
  });

  it('clears the milestone when the project changes', () => {
    const moved = applyChange(
      issue({ project_id: 'prj-1', project_milestone_id: 'ms-1' }),
      { project_id: 'prj-2' }
    );

    expect(moved.project_milestone_id).toBeNull();
  });
});

describe('chip filters', () => {
  it('stands a status for every like named status across teams', () => {
    expect(filterValuesFor('status', 'st-todo', context).sort()).toEqual([
      'st-todo',
      'st-todo-2',
    ]);
  });

  it('stands a label for every like named label across teams', () => {
    expect(filterValuesFor('label', 'lb-bug', context).sort()).toEqual([
      'lb-bug',
      'lb-bug-2',
    ]);
  });

  it('keeps any other value as it is', () => {
    expect(filterValuesFor('estimate', 'M', context)).toEqual(['M']);
    expect(filterValuesFor('priority', 'high', context)).toEqual(['high']);
  });

  it('narrows one field and leaves the others', () => {
    expect(
      narrowFilters(
        [
          { field: 'label', op: 'is_not', values: ['lb-ui'] },
          { field: 'priority', op: 'is', values: ['low'] },
        ],
        'label',
        ['lb-bug']
      )
    ).toEqual([
      { field: 'priority', op: 'is', values: ['low'] },
      { field: 'label', op: 'is', values: ['lb-bug'] },
    ]);
  });

  it('matches issues on the client', () => {
    const bug = issue({ label_ids: ['lb-bug'], estimate: 'M' });
    const plain = issue({ id: 'iss-2' });
    const byEstimate = [
      { field: 'estimate' as const, op: 'is' as const, values: ['M'] },
    ];
    expect(matchesFilters(bug, byEstimate)).toBe(true);
    expect(matchesFilters(plain, byEstimate)).toBe(false);
    expect(
      matchesFilters(plain, [
        { field: 'label', op: 'is', values: [NONE] },
        { field: 'priority', op: 'is_not', values: ['high'] },
      ])
    ).toBe(true);
    expect(
      matchesFilters(bug, [
        { field: 'label', op: 'is_not', values: ['lb-bug'] },
      ])
    ).toBe(false);
  });
});

describe('the estimate filter', () => {
  it('queries estimates and their exclusions', () => {
    expect(
      viewStateQuery({
        ...base,
        filters: [
          { field: 'estimate', op: 'is', values: ['M'] },
          { field: 'estimate', op: 'is_not', values: [NONE] },
        ],
      })
    ).toEqual(
      expect.objectContaining({ estimate: ['M'], estimate_not: [NONE] })
    );
  });
});

describe('the relation and relative cycle filters', () => {
  it('sends one boolean and drops a clause holding both answers', () => {
    expect(
      viewStateQuery({
        ...base,
        filters: [
          { field: 'blocked', op: 'is', values: ['true'] },
          { field: 'blocking', op: 'is', values: ['true', 'false'] },
          { field: 'relation', op: 'is', values: ['blocks', 'relates_to'] },
        ],
      })
    ).toEqual(
      expect.objectContaining({
        is_blocked: 'true',
        has_relation: ['blocks', 'relates_to'],
      })
    );
    expect(
      viewStateQuery({
        ...base,
        filters: [{ field: 'blocking', op: 'is', values: ['true', 'false'] }],
      })
    ).not.toHaveProperty('is_blocking');
  });

  it('matches blocked on the client and leaves link filters to the server', () => {
    const held = issue({ blocked_by_open_count: 1 });
    const free = issue({ id: 'iss-2' });
    const blocked = [
      { field: 'blocked' as const, op: 'is' as const, values: ['true'] },
    ];
    expect(matchesFilters(held, blocked)).toBe(true);
    expect(matchesFilters(free, blocked)).toBe(false);
    expect(
      matchesFilters(free, [
        { field: 'relation', op: 'is', values: ['blocks'] },
        { field: 'cycle', op: 'is', values: ['current'] },
      ])
    ).toBe(true);
  });

  it('reads saved relation filters back into clauses', () => {
    const state = viewToState({
      filter: { is_blocking: 'false', has_relation: ['duplicate_of'] },
    } as unknown as SavedViewDisplayRead);
    expect(state.filters).toEqual([
      { field: 'blocking', op: 'is', values: ['false'] },
      { field: 'relation', op: 'is', values: ['duplicate_of'] },
    ]);
  });

  it('lets only the right caller move a view without a team', () => {
    const own = { team_id: null, scope: 'personal' as const, owner_id: 'u1' };
    const everyone = { ...own, scope: 'workspace' as const };
    expect(viewVisibility(own, 'u1', 'member').rescopable).toBe(true);
    expect(viewVisibility(own, 'u1', 'guest').rescopable).toBe(false);
    expect(viewVisibility(everyone, 'u2', 'admin').rescopable).toBe(false);
    expect(viewVisibility({ ...own, team_id: 't1' }, 'u1', 'member')).toEqual({
      rescopable: false,
      initialShared: false,
    });
    expect(sharedChange(own, true)).toEqual({ shared: true });
    expect(sharedChange(everyone, true)).toEqual({});
  });
});
