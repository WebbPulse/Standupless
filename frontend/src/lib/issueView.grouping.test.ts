/**
 * The project, cycle, parent, team and SLA groupings, the status, start date
 * and estimate orderings, and the ordering direction: how rows fall into
 * groups, what a drag between groups writes, and how the direction rides the
 * URL, the list query and a saved view.
 */

import { describe, expect, it } from 'vitest';
import { NONE, type OrderedIssueRead } from '../api/issues';
import type { SavedViewDisplayRead } from '../api/views';
import type { CycleRead, ProjectRead } from '../types/Api';
import {
  defaultViewState,
  estimatePoints,
  fieldsFor,
  GROUP_FIELDS,
  groupIssues,
  moveChange,
  ORDERINGS,
  parentsIn,
  parseViewState,
  sameViewState,
  sortIssues,
  stateToViewBody,
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

const COUNTS = { todo: 1, in_progress: 0, done: 1, cancelled: 0, total: 2 };

/** A project of team-1 with the given name and status. */
const project = (
  id: string,
  name: string,
  fields: Partial<ProjectRead> = {}
): ProjectRead => ({
  project_id: id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  name,
  description: null,
  lead_id: null,
  start_date: null,
  target_date: null,
  status: 'in_progress',
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
  counts: COUNTS,
  created_by: 'user-1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  ...fields,
});

/** A cycle of team-1 starting on the given date. */
const cycle = (
  id: string,
  name: string,
  start: string,
  fields: Partial<CycleRead> = {}
): CycleRead => ({
  cycle_id: id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  name,
  start_date: start,
  end_date: start,
  goal: null,
  cancelled: false,
  status: 'upcoming',
  counts: COUNTS,
  created_by: 'user-1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  ...fields,
});

/** Two teams with their statuses, projects and cycles. */
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
      id: 'st-doing',
      name: 'Doing',
      category: 'started',
      position: 0,
      team_id: 'team-1',
    },
    {
      id: 'st-review',
      name: 'Review',
      category: 'started',
      position: 1,
      team_id: 'team-1',
    },
    {
      id: 'st-backlog',
      name: 'Backlog',
      category: 'backlog',
      position: 0,
      team_id: 'team-1',
    },
    {
      id: 'st-done',
      name: 'Done',
      category: 'completed',
      position: 0,
      team_id: 'team-1',
    },
  ],
  labels: [],
  people: [],
  projects: [
    project('prj-web', 'Website'),
    project('prj-api', 'API'),
    project('prj-old', 'Archive', { status: 'completed' }),
    project('prj-shared', 'Shared', {
      team_id: 'team-2',
      team_ids: ['team-2'],
    }),
  ],
  cycles: [
    cycle('cy-2', 'Cycle 2', '2026-10-13'),
    cycle('cy-1', 'Cycle 1', '2026-09-29', { status: 'active' }),
    cycle('cy-0', 'Cycle 0', '2026-09-15', { status: 'completed' }),
    cycle('cy-other', 'Cycle 9', '2026-10-01', { team_id: 'team-2' }),
  ],
  teams: [
    { id: 'team-1', name: 'Engineering', key: 'ENG' },
    { id: 'team-2', name: 'Design', key: 'DES' },
  ],
};

const keys = (groups: { key: string }[]): string[] =>
  groups.map((group) => group.key);

const ids = (rows: OrderedIssueRead[]): string[] => rows.map((row) => row.id);

describe('grouping by planning fields', () => {
  it('offers the new groupings, with team only over several teams', () => {
    expect(GROUP_FIELDS).toEqual(
      expect.arrayContaining(['project', 'cycle', 'parent', 'team', 'sla'])
    );
    expect(fieldsFor(GROUP_FIELDS, {})).not.toContain('team');
    expect(fieldsFor(GROUP_FIELDS, context)).toContain('team');
    expect(fieldsFor(GROUP_FIELDS, {})).toContain('project');
  });

  it('lists open projects by name, then a closed one a row sits in, then none', () => {
    const groups = groupIssues(
      [
        issue({ id: 'a', project_id: 'prj-web' }),
        issue({ id: 'b', project_id: 'prj-old' }),
        issue({ id: 'c' }),
      ],
      'project',
      context,
      true
    );

    expect(keys(groups)).toEqual([
      'prj-api',
      'prj-shared',
      'prj-web',
      NONE,
      'prj-old',
    ]);
    expect(groups.find((group) => group.key === 'prj-old')?.label).toBe(
      'Archive'
    );
    expect(groups.find((group) => group.key === NONE)?.label).toBe(
      'No project'
    );
    expect(groups[0]?.progress).toBe(50);
  });

  it('lists open cycles by start date with the team key over several teams', () => {
    const groups = groupIssues(
      [
        issue({ id: 'a', cycle_id: 'cy-1' }),
        issue({ id: 'b', cycle_id: 'cy-0' }),
      ],
      'cycle',
      context,
      false
    );

    expect(keys(groups)).toEqual(['cy-1', 'cy-0']);
    expect(groups.map((group) => group.label)).toEqual([
      'ENG Cycle 1',
      'ENG Cycle 0',
    ]);

    const shells = groupIssues([], 'cycle', { ...context, teams: [] }, true);
    expect(keys(shells)).toEqual(['cy-1', 'cy-other', 'cy-2', NONE]);
    expect(shells[0]?.label).toBe('Cycle 1');
  });

  it('heads each parent group with its key and title, with no parent last', () => {
    const rows = [
      issue({ id: 'lone' }),
      issue({ id: 'child-1', parent_id: 'epic' }),
      issue({ id: 'epic', key: 'ENG-7', title: 'Login revamp' }),
      issue({ id: 'child-2', parent_id: 'gone' }),
    ];
    const groups = groupIssues(
      rows,
      'parent',
      { ...context, parents: parentsIn(rows) },
      false
    );

    expect(keys(groups)).toEqual(['epic', 'gone', NONE]);
    expect(groups.map((group) => group.label)).toEqual([
      'ENG-7 Login revamp',
      'Unknown parent',
      'No parent',
    ]);
    expect(ids(groups[2]?.issues ?? [])).toEqual(['lone', 'epic']);
  });

  it('groups by team in the listed team order', () => {
    const groups = groupIssues(
      [issue({ id: 'a', team_id: 'team-2' }), issue({ id: 'b' })],
      'team',
      context,
      false
    );

    expect(keys(groups)).toEqual(['team-1', 'team-2']);
    expect(groups.map((group) => group.label)).toEqual([
      'Engineering',
      'Design',
    ]);
  });

  it('groups by live SLA status, the most urgent first', () => {
    const past = '2020-01-01T00:00:00Z';
    const future = '2999-01-01T00:00:00Z';
    const groups = groupIssues(
      [
        issue({ id: 'none' }),
        issue({
          id: 'late',
          sla_status: 'on_track',
          sla_started_at: past,
          sla_breaches_at: past,
        }),
        issue({
          id: 'fine',
          sla_status: 'on_track',
          sla_started_at: past,
          sla_breaches_at: future,
        }),
      ],
      'sla',
      context,
      false
    );

    expect(keys(groups)).toEqual(['breached', 'on_track', 'none']);
    expect(groups.map((group) => group.label)).toEqual([
      'Breached',
      'On track',
      'No SLA',
    ]);
  });
});

describe('dragging between planning groups', () => {
  it('moves into a project the issue team shares, and out of any', () => {
    const moving = issue({ project_id: 'prj-web' });

    expect(
      moveChange(moving, 'project', 'prj-web', 'prj-api', context)
    ).toEqual({ project_id: 'prj-api' });
    expect(moveChange(moving, 'project', 'prj-web', NONE, context)).toEqual({
      project_id: null,
    });
    expect(
      moveChange(moving, 'project', 'prj-web', 'prj-shared', context)
    ).toBeNull();
  });

  it('moves into a cycle of the issue own team only', () => {
    const moving = issue({ cycle_id: 'cy-1' });

    expect(moveChange(moving, 'cycle', 'cy-1', 'cy-2', context)).toEqual({
      cycle_id: 'cy-2',
    });
    expect(moveChange(moving, 'cycle', 'cy-1', NONE, context)).toEqual({
      cycle_id: null,
    });
    expect(moveChange(moving, 'cycle', 'cy-1', 'cy-other', context)).toBeNull();
  });

  it('refuses a drag into a parent, team or SLA column', () => {
    expect(moveChange(issue(), 'parent', NONE, 'epic', context)).toBeNull();
    expect(moveChange(issue(), 'team', 'team-1', 'team-2', context)).toBeNull();
    expect(moveChange(issue(), 'sla', 'none', 'breached', context)).toBeNull();
  });
});

describe('the new orderings', () => {
  it('offers status, start date and estimate', () => {
    expect(ORDERINGS).toEqual(
      expect.arrayContaining(['status_asc', 'start_asc', 'estimate_desc'])
    );
  });

  it('orders by board status, triage first, then priority', () => {
    const sorted = sortIssues(
      [
        issue({ id: 'done', status_id: 'st-done' }),
        issue({ id: 'review', status_id: 'st-review' }),
        issue({ id: 'doing-low', status_id: 'st-doing', priority: 'low' }),
        issue({
          id: 'doing-urgent',
          status_id: 'st-doing',
          priority: 'urgent',
        }),
        issue({ id: 'backlog', status_id: 'st-backlog' }),
        issue({ id: 'triage', status_id: 'st-done', in_triage: true }),
        issue({ id: 'todo', status_id: 'st-todo' }),
      ],
      'status_asc',
      { context }
    );

    expect(ids(sorted)).toEqual([
      'triage',
      'backlog',
      'todo',
      'doing-urgent',
      'doing-low',
      'review',
      'done',
    ]);
  });

  it('orders by start date with undated rows last in either direction', () => {
    const rows = [
      issue({ id: 'none' }),
      issue({ id: 'late', start_date: '2026-11-01' }),
      issue({ id: 'early', start_date: '2026-10-01' }),
    ];

    expect(ids(sortIssues(rows, 'start_asc'))).toEqual([
      'early',
      'late',
      'none',
    ]);
    expect(ids(sortIssues(rows, 'start_asc', { reverse: true }))).toEqual([
      'late',
      'early',
      'none',
    ]);
  });

  it('orders by estimate points, largest first, unestimated last', () => {
    const rows = [
      issue({ id: 'none' }),
      issue({ id: 'small', estimate: 'S' }),
      issue({ id: 'zero', estimate: '0' }),
      issue({ id: 'big', estimate: '8' }),
      issue({ id: 'medium', estimate: 'M' }),
    ];

    expect(ids(sortIssues(rows, 'estimate_desc'))).toEqual([
      'big',
      'medium',
      'small',
      'zero',
      'none',
    ]);
    expect(ids(sortIssues(rows, 'estimate_desc', { reverse: true }))).toEqual([
      'zero',
      'small',
      'medium',
      'big',
      'none',
    ]);
    expect(estimatePoints('XXXL')).toBe(21);
    expect(estimatePoints('soon')).toBe(0);
  });

  it('reverses an ordering over a value every row has', () => {
    const rows = [
      issue({ id: 'a', key: 'ENG-1', number: 1 }),
      issue({ id: 'b', key: 'ENG-2', number: 2 }),
    ];

    expect(ids(sortIssues(rows, 'key_asc', { reverse: true }))).toEqual([
      'b',
      'a',
    ]);
  });

  it('keeps rows with no due date last when reversed', () => {
    const rows = [
      issue({ id: 'none' }),
      issue({ id: 'soon', due_date: '2026-10-20' }),
      issue({ id: 'later', due_date: '2026-12-01' }),
    ];

    expect(ids(sortIssues(rows, 'due_asc', { reverse: true }))).toEqual([
      'later',
      'soon',
      'none',
    ]);
  });
});

describe('the ordering direction', () => {
  const base = defaultViewState('list');
  const reversed: ViewState = {
    ...base,
    groupBy: 'cycle',
    subGroupBy: 'project',
    ordering: 'start_asc',
    reverse: true,
  };

  it('starts forward and rides the URL', () => {
    expect(base.reverse).toBe(false);
    const params = writeViewState(reversed, base);

    expect(params.get('rev')).toBe('1');
    expect(params.get('group')).toBe('cycle');
    expect(sameViewState(parseViewState(params, base), reversed)).toBe(true);
    expect(writeViewState(base, base).has('rev')).toBe(false);
    expect(sameViewState(reversed, { ...reversed, reverse: false })).toBe(
      false
    );
  });

  it('asks the list route for the reversed order only when set', () => {
    expect(viewStateQuery(reversed)).toMatchObject({
      sort: 'start_asc',
      reverse: true,
    });
    expect(viewStateQuery(base)).not.toHaveProperty('reverse');
  });

  it('saves the grouping and direction and reads them back', () => {
    const body = stateToViewBody(reversed, 'Upcoming work');

    expect(body).toMatchObject({
      group_by: 'cycle',
      sub_group_by: 'project',
      ordering: 'start_asc',
      ordering_reversed: true,
    });
    const view = {
      view_id: 'v-1',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead;

    expect(sameViewState(viewToState(view), reversed)).toBe(true);
    const older: Partial<SavedViewDisplayRead> = { ...view };
    delete older.ordering_reversed;
    expect(viewToState(older as SavedViewDisplayRead).reverse).toBe(false);
  });
});
