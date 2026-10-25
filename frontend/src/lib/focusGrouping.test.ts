/**
 * The Focus grouping of My issues > Assigned: which section each issue lands
 * in, first match winning, how rows order inside a section, that empty
 * sections never show, that only a page opening on Focus reads it from the
 * URL, and that it never reaches a saved view or a team default.
 */

import { describe, expect, it } from 'vitest';
import type { OrderedIssueRead } from '../api/issues';
import type { CycleRead } from '../types/Api';
import {
  currentCycleIds,
  FOCUS_SECTIONS,
  focusSectionOf,
  orderWithinFocus,
  type FocusIssue,
} from './focusGrouping';
import {
  defaultViewState,
  groupFieldsFor,
  groupIssues,
  parseViewState,
  stateToViewDisplay,
  usesFocusGrouping,
  type IssueContext,
  type ViewState,
} from './issueView';
import { stateToTeamDisplay } from './teamDisplay';

const NOW = new Date('2026-10-25T12:00:00Z');

/** An open, unprioritised issue with no SLA, cycle or blockers. */
const plain = (fields: Partial<FocusIssue> = {}): FocusIssue => ({
  priority: 'none',
  cycle_id: null,
  in_triage: false,
  blocking_count: 0,
  sla_status: 'none',
  sla_started_at: null,
  sla_breaches_at: null,
  sla_paused_at: null,
  ...fields,
});

const CURRENT = new Set(['cy-now']);

const sectionOf = (
  fields: Partial<FocusIssue>,
  category: Parameters<typeof focusSectionOf>[1] = 'unstarted'
) => focusSectionOf(plain(fields), category, CURRENT, NOW);

describe('focus section assignment', () => {
  it('lists the sections from the most pressing to done', () => {
    expect(FOCUS_SECTIONS).toEqual([
      'urgent',
      'sla',
      'blockers',
      'cycle',
      'active',
      'triage',
      'backlog',
      'completed',
    ]);
  });

  it('puts an open urgent issue under Urgent, ahead of everything else', () => {
    expect(
      sectionOf({
        priority: 'urgent',
        blocking_count: 2,
        cycle_id: 'cy-now',
        sla_status: 'breached',
        sla_breaches_at: '2026-10-24T00:00:00Z',
      })
    ).toBe('urgent');
    expect(sectionOf({ priority: 'urgent' }, 'backlog')).toBe('urgent');
  });

  it('keeps an urgent issue in triage out of Urgent', () => {
    expect(sectionOf({ priority: 'urgent', in_triage: true })).toBe('triage');
  });

  it('puts an at risk, breached or running SLA under SLA', () => {
    expect(
      sectionOf({
        sla_status: 'breached',
        sla_breaches_at: '2026-10-24T00:00:00Z',
      })
    ).toBe('sla');
    expect(
      sectionOf({
        sla_status: 'at_risk',
        sla_started_at: '2026-10-20T00:00:00Z',
        sla_breaches_at: '2026-10-25T18:00:00Z',
      })
    ).toBe('sla');
    expect(
      sectionOf({
        sla_status: 'on_track',
        sla_started_at: '2026-10-25T00:00:00Z',
        sla_breaches_at: '2026-11-10T00:00:00Z',
      })
    ).toBe('sla');
  });

  it('leaves a paused on track SLA and no SLA out of the SLA section', () => {
    expect(
      sectionOf({
        sla_status: 'on_track',
        sla_started_at: '2026-10-25T00:00:00Z',
        sla_breaches_at: '2026-11-10T00:00:00Z',
        sla_paused_at: '2026-10-25T06:00:00Z',
      })
    ).toBe('active');
    expect(sectionOf({ sla_status: 'none' })).toBe('active');
  });

  it('puts an issue blocking others under Blockers, ahead of cycle work', () => {
    expect(sectionOf({ blocking_count: 1, cycle_id: 'cy-now' })).toBe(
      'blockers'
    );
  });

  it('puts an issue in its team current cycle under Cycle work', () => {
    expect(sectionOf({ cycle_id: 'cy-now' }, 'backlog')).toBe('cycle');
    expect(sectionOf({ cycle_id: 'cy-next' })).toBe('active');
  });

  it('sorts the rest by triage and status category', () => {
    expect(sectionOf({}, 'started')).toBe('active');
    expect(sectionOf({}, 'unstarted')).toBe('active');
    expect(sectionOf({}, undefined)).toBe('active');
    expect(sectionOf({ in_triage: true }, 'backlog')).toBe('triage');
    expect(sectionOf({}, 'backlog')).toBe('backlog');
  });

  it('puts every closed issue under Completed, whatever else it carries', () => {
    expect(
      sectionOf({ priority: 'urgent', blocking_count: 1 }, 'completed')
    ).toBe('completed');
    expect(sectionOf({ cycle_id: 'cy-now' }, 'cancelled')).toBe('completed');
  });

  it('takes each team current cycle, never a cancelled or finished one', () => {
    const cycle = (id: string, fields: Partial<CycleRead>): CycleRead =>
      ({
        cycle_id: id,
        cancelled: false,
        status: 'upcoming',
        ...fields,
      }) as CycleRead;
    expect([
      ...currentCycleIds([
        cycle('a', { status: 'active' }),
        cycle('b', { status: 'active', team_id: 'team-2' }),
        cycle('c', { status: 'active', cancelled: true }),
        cycle('d', { status: 'completed' }),
        cycle('e', {}),
      ]),
    ]).toEqual(['a', 'b']);
  });
});

describe('ordering within a section', () => {
  it('puts started issues first, then priority, then the incoming order', () => {
    const rows = [
      { id: 'low-todo', priority: 'low' as const, category: 'unstarted' },
      { id: 'none-doing', priority: 'none' as const, category: 'started' },
      { id: 'high-todo-1', priority: 'high' as const, category: 'unstarted' },
      { id: 'high-doing', priority: 'high' as const, category: 'started' },
      { id: 'high-todo-2', priority: 'high' as const, category: 'unstarted' },
    ];
    expect(
      orderWithinFocus(rows, (row) => row.category as 'started').map(
        (row) => row.id
      )
    ).toEqual([
      'high-doing',
      'none-doing',
      'high-todo-1',
      'high-todo-2',
      'low-todo',
    ]);
  });
});

/** An issue of team-1 with the given fields. */
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
  assignee_id: 'user-1',
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
  projects: [],
  cycles: [
    {
      cycle_id: 'cy-now',
      team_id: 'team-1',
      status: 'active',
      cancelled: false,
    } as CycleRead,
  ],
};

describe('grouping a list by focus', () => {
  it('fills the sections in order and hides empty ones even when shown', () => {
    const groups = groupIssues(
      [
        issue({ id: 'todo-low', priority: 'low' }),
        issue({ id: 'urgent', priority: 'urgent' }),
        issue({ id: 'doing', status_id: 'st-doing', priority: 'none' }),
        issue({ id: 'cycle', cycle_id: 'cy-now' }),
        issue({ id: 'backlog', status_id: 'st-backlog' }),
        issue({ id: 'done', status_id: 'st-done' }),
        issue({ id: 'todo-high', priority: 'high' }),
      ],
      'focus',
      context,
      true
    );
    expect(
      groups.map((group) => [group.label, group.issues.map((row) => row.id)])
    ).toEqual([
      ['Urgent', ['urgent']],
      ['Cycle work', ['cycle']],
      ['Other active work', ['doing', 'todo-high', 'todo-low']],
      ['Backlog', ['backlog']],
      ['Completed', ['done']],
    ]);
    expect(groups.every((group) => group.field === 'focus')).toBe(true);
  });

  it('is offered only where asked for, first in the menu', () => {
    expect(groupFieldsFor(context)).not.toContain('focus');
    expect(groupFieldsFor(context, { focus: true })[0]).toBe('focus');
  });
});

describe('focus in the URL and in saves', () => {
  const focusBase: ViewState = {
    ...defaultViewState('list'),
    groupBy: 'focus',
  };

  it('reads focus back only over a page that opens on it', () => {
    const params = new URLSearchParams('group=focus');
    expect(parseViewState(params, defaultViewState('list')).groupBy).toBe(
      'status'
    );
    expect(
      parseViewState(new URLSearchParams('group=status'), focusBase).groupBy
    ).toBe('status');
    expect(parseViewState(new URLSearchParams(), focusBase).groupBy).toBe(
      'focus'
    );
    expect(
      parseViewState(new URLSearchParams('sub=focus'), focusBase).subGroupBy
    ).toBe('none');
  });

  it('flags a focus state as unsavable and never writes focus to a save', () => {
    expect(usesFocusGrouping(focusBase)).toBe(true);
    expect(usesFocusGrouping(defaultViewState('list'))).toBe(false);
    expect(stateToViewDisplay(focusBase).group_by).toBeNull();
    expect(stateToTeamDisplay(focusBase).group_by).toBe('none');
  });
});
