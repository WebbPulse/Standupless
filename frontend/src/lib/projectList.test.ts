/**
 * The projects list's ordering, grouping and display. Covers that dates run
 * soonest first with undated rows last, that ties fall back to the name, that
 * priority runs urgent first, that lead groups put "No lead" last, that a
 * project on two teams shows under both, that health, priority and initiative
 * groups run in their own order, that the board keeps empty columns and moves
 * a card by the column's value, that the completed window keeps recent closes
 * only, that groups reverse, that the second grouping drops when it repeats
 * the first, that a team page can keep only the projects it leads, and that
 * the display reads the URL before the saved choice. Manual ordering runs by
 * the stored rank with unplaced projects last, and a drop writes the keys
 * that put a project where it was dropped.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectRead, TeamRead } from '../types/Api';
import {
  DEFAULT_PROJECTS_DISPLAY,
  cellChange,
  directedGroups,
  dropPatch,
  effectiveRows,
  groupPatch,
  groupProjects,
  inGroup,
  manualPlacements,
  parseGrouping,
  parseOrdering,
  resolveDisplay,
  sortProjects,
  withinClosedWindow,
  withinLeadTeams,
} from './projectList';

const base: ProjectRead = {
  project_id: 'p1',
  workspace_id: 'ws',
  team_id: 't1',
  team_ids: ['t1'],
  name: 'Base',
  description: null,
  lead_id: null,
  start_date: null,
  target_date: null,
  status: 'planned',
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'u1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const project = (patch: Partial<ProjectRead>): ProjectRead => ({
  ...base,
  ...patch,
});

const team = (id: string, name: string): TeamRead => ({
  id,
  workspace_id: 'ws',
  name,
  key_prefix: name.slice(0, 3).toUpperCase(),
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
});

const names = (rows: ProjectRead[]): string[] => rows.map((row) => row.name);

describe('sortProjects', () => {
  const rows = [
    project({ project_id: 'a', name: 'Undated' }),
    project({ project_id: 'b', name: 'Late', target_date: '2026-12-01' }),
    project({ project_id: 'c', name: 'Early', target_date: '2026-10-01' }),
    project({
      project_id: 'd',
      name: 'Done',
      counts: { todo: 0, in_progress: 0, done: 2, cancelled: 0, total: 2 },
      updated_at: '2026-09-20T00:00:00Z',
    }),
  ];

  it('runs target dates soonest first and undated last, ties by name', () => {
    expect(names(sortProjects(rows, 'target'))).toEqual([
      'Early',
      'Late',
      'Done',
      'Undated',
    ]);
  });

  it('runs progress highest first', () => {
    expect(names(sortProjects(rows, 'progress'))[0]).toBe('Done');
  });

  it('runs the last updated first', () => {
    expect(names(sortProjects(rows, 'updated'))[0]).toBe('Done');
  });

  it('runs priority urgent first and no priority last', () => {
    expect(
      names(
        sortProjects(
          [
            project({ project_id: 'a', name: 'None', priority: 'none' }),
            project({ project_id: 'b', name: 'Low', priority: 'low' }),
            project({ project_id: 'c', name: 'Urgent', priority: 'urgent' }),
          ],
          'priority'
        )
      )
    ).toEqual(['Urgent', 'Low', 'None']);
  });

  it('orders by name', () => {
    expect(names(sortProjects(rows, 'name'))).toEqual([
      'Done',
      'Early',
      'Late',
      'Undated',
    ]);
  });

  it('orders by important customer requests, most first', () => {
    const asked = [
      project({ project_id: 'a', name: 'Few', customer_important_count: 1 }),
      project({ project_id: 'b', name: 'None', customer_important_count: 0 }),
      project({ project_id: 'c', name: 'Many', customer_important_count: 3 }),
    ];
    expect(names(sortProjects(asked, 'important'))).toEqual([
      'Many',
      'Few',
      'None',
    ]);
  });
});

describe('groupProjects', () => {
  const people = [
    { user_id: 'u2', email: 'zed@example.com', display_name: 'Zed' },
    { user_id: 'u1', email: 'amy@example.com', display_name: 'Amy' },
  ];

  it('puts lead groups in name order with no lead last', () => {
    const groups = groupProjects(
      [
        project({ project_id: 'a', lead_id: null }),
        project({ project_id: 'b', lead_id: 'u2' }),
        project({ project_id: 'c', lead_id: 'u1' }),
      ],
      'lead',
      people,
      []
    );
    expect(groups.map((group) => group.label)).toEqual([
      'Amy',
      'Zed',
      'No lead',
    ]);
  });

  it('shows a project on two teams under each team', () => {
    const groups = groupProjects(
      [project({ team_ids: ['t1', 't2'] })],
      'team',
      [],
      [team('t1', 'Engine'), team('t2', 'Design'), team('t3', 'Empty')]
    );
    expect(groups.map((group) => group.label)).toEqual(['Engine', 'Design']);
    expect(groups.map((group) => group.rows.length)).toEqual([1, 1]);
  });

  it('shows each project once under the filtered teams only', () => {
    const groups = groupProjects(
      [
        project({ project_id: 'a', team_ids: ['t1', 't2'] }),
        project({ project_id: 'b', team_ids: ['t3', 't2'] }),
        project({ project_id: 'c', team_ids: ['t3'] }),
      ],
      'team',
      [],
      [team('t1', 'Engine'), team('t2', 'Design'), team('t3', 'Mobile')],
      { teamIds: ['t2', 't3'] }
    );
    expect(groups.map((group) => group.label)).toEqual(['Design', 'Mobile']);
    expect(
      groups.map((group) => group.rows.map((row) => row.project_id))
    ).toEqual([['a', 'b'], ['c']]);
  });

  it('leaves empty status groups out', () => {
    const groups = groupProjects(
      [project({ status: 'completed' })],
      'status',
      [],
      []
    );
    expect(groups.map((group) => group.key)).toEqual(['status:completed']);
  });
});

describe('health, priority and initiative groups', () => {
  it('runs health from on track to no updates', () => {
    const groups = groupProjects(
      [
        project({ project_id: 'a', health: null }),
        project({ project_id: 'b', health: 'off_track' }),
        project({ project_id: 'c', health: 'on_track' }),
      ],
      'health',
      [],
      []
    );
    expect(groups.map((group) => group.label)).toEqual([
      'On track',
      'Off track',
      'No updates',
    ]);
  });

  it('runs priority from urgent to none', () => {
    const groups = groupProjects(
      [
        project({ project_id: 'a', priority: 'none' }),
        project({ project_id: 'b', priority: 'high' }),
      ],
      'priority',
      [],
      []
    );
    expect(groups.map((group) => group.key)).toEqual([
      'priority:high',
      'priority:none',
    ]);
  });

  it('names initiatives and puts projects outside one last', () => {
    const groups = groupProjects(
      [
        project({ project_id: 'a', initiative_id: null }),
        project({ project_id: 'b', initiative_id: 'i2' }),
        project({ project_id: 'c', initiative_id: 'i1' }),
      ],
      'initiative',
      [],
      [],
      {
        initiatives: [
          { initiative_id: 'i1', name: 'Scale' },
          { initiative_id: 'i2', name: 'Growth' },
        ],
      }
    );
    expect(groups.map((group) => group.label)).toEqual([
      'Growth',
      'Scale',
      'No initiative',
    ]);
  });

  it('keeps empty columns for the board', () => {
    const groups = groupProjects(
      [project({ health: 'at_risk' })],
      'health',
      [],
      [],
      { keepEmpty: true }
    );
    expect(groups.map((group) => group.key)).toEqual([
      'health:on_track',
      'health:at_risk',
      'health:off_track',
      'health:none',
    ]);
  });
});

describe('group direction and second grouping', () => {
  it('reverses the groups when descending', () => {
    const groups = groupProjects([], 'health', [], [], { keepEmpty: true });
    expect(directedGroups(groups, 'desc').map((group) => group.key)).toEqual([
      'health:none',
      'health:off_track',
      'health:at_risk',
      'health:on_track',
    ]);
    expect(directedGroups(groups, 'asc')).toBe(groups);
  });

  it('drops a second grouping that repeats the first or has no first', () => {
    expect(effectiveRows('status', 'lead')).toBe('lead');
    expect(effectiveRows('status', 'status')).toBe('none');
    expect(effectiveRows('none', 'lead')).toBe('none');
  });
});

describe('lead team projects', () => {
  const led = project({ team_id: 't1', team_ids: ['t1', 't2'] });
  const joined = project({ team_id: 't2', team_ids: ['t1', 't2'] });

  it('keeps every project on the team by default', () => {
    expect(withinLeadTeams(joined, 'all', ['t1'])).toBe(true);
  });

  it('keeps only the projects the team leads when asked', () => {
    expect(withinLeadTeams(led, 'lead', ['t1'])).toBe(true);
    expect(withinLeadTeams(joined, 'lead', ['t1'])).toBe(false);
  });

  it('keeps everything off a team page', () => {
    expect(withinLeadTeams(joined, 'lead', null)).toBe(true);
  });
});

describe('board moves', () => {
  const [onTrack, , , noUpdates] = groupProjects([], 'health', [], [], {
    keepEmpty: true,
  });

  it('moves a card by the column value', () => {
    if (onTrack === undefined || noUpdates === undefined)
      throw new Error('no health columns');
    expect(groupPatch(onTrack)).toEqual({ health: 'on_track' });
    expect(groupPatch(noUpdates)).toEqual({ health: null });
    expect(inGroup(project({ health: null }), noUpdates)).toBe(true);
    expect(inGroup(project({ health: null }), onTrack)).toBe(false);
  });

  it('takes no drop on a team column', () => {
    const [engine] = groupProjects([], 'team', [], [team('t1', 'Engine')], {
      keepEmpty: true,
    });
    if (engine === undefined) throw new Error('no team column');
    expect(groupPatch(engine)).toBeNull();
  });

  it('changes both fields on a drop into a column and a swimlane', () => {
    const planned = groupProjects([], 'status', [], [], {
      keepEmpty: true,
    }).find((group) => group.key === 'status:planned');
    const high = groupProjects([], 'priority', [], [], {
      keepEmpty: true,
    }).find((group) => group.key === 'priority:high');
    if (planned === undefined || high === undefined)
      throw new Error('no groups');
    expect(
      dropPatch(project({ status: 'planned', priority: 'low' }), [
        planned,
        high,
      ])
    ).toEqual({ priority: 'high' });
    expect(
      dropPatch(project({ status: 'backlog', priority: 'low' }), [
        planned,
        high,
      ])
    ).toEqual({ status: 'planned', priority: 'high' });
    expect(
      dropPatch(project({ status: 'planned', priority: 'high' }), [
        planned,
        high,
      ])
    ).toBeNull();
  });

  it('refuses a swimlane drop that would join a team', () => {
    const planned = groupProjects([], 'status', [], [], {
      keepEmpty: true,
    }).find((group) => group.key === 'status:planned');
    const [design] = groupProjects([], 'team', [], [team('t2', 'Design')], {
      keepEmpty: true,
    });
    if (planned === undefined || design === undefined)
      throw new Error('no groups');
    expect(
      dropPatch(project({ status: 'backlog' }), [planned, design])
    ).toBeNull();
  });
});

describe('closed window', () => {
  const now = new Date('2026-10-21T00:00:00Z');

  it('keeps open projects whatever the window', () => {
    expect(withinClosedWindow(project({}), 'none', now)).toBe(true);
  });

  it('keeps a recent completion and drops an old one', () => {
    const recent = project({
      status: 'completed',
      completed_at: '2026-10-11T00:00:00Z',
    });
    const old = project({
      status: 'completed',
      completed_at: '2026-08-01T00:00:00Z',
    });
    expect(withinClosedWindow(recent, 'fortnight', now)).toBe(true);
    expect(withinClosedWindow(old, 'month', now)).toBe(false);
    expect(withinClosedWindow(old, 'all', now)).toBe(true);
    expect(withinClosedWindow(recent, 'none', now)).toBe(false);
  });

  it('keeps canceled projects only when all closed projects show', () => {
    const canceled = project({
      status: 'canceled',
      completed_at: '2026-10-20T00:00:00Z',
    });
    expect(withinClosedWindow(canceled, 'fortnight', now)).toBe(false);
    expect(withinClosedWindow(canceled, 'month', now)).toBe(false);
    expect(withinClosedWindow(canceled, 'all', now)).toBe(true);
  });

  it('falls back to the last update before closes were recorded', () => {
    const closed = project({
      status: 'completed',
      updated_at: '2026-10-20T00:00:00Z',
    });
    const stale = project({
      status: 'completed',
      updated_at: '2026-09-20T00:00:00Z',
    });
    expect(withinClosedWindow(closed, 'fortnight', now)).toBe(true);
    expect(withinClosedWindow(stale, 'fortnight', now)).toBe(false);
  });
});

describe('resolveDisplay', () => {
  it('reads the URL first, then the saved choice, then the default', () => {
    const url: Record<string, string> = { layout: 'board', group: 'bogus' };
    const display = resolveDisplay((field) => url[field] ?? null, {
      ...DEFAULT_PROJECTS_DISPLAY,
      layout: 'timeline',
      group: 'health',
    });
    expect(display).toEqual({
      ...DEFAULT_PROJECTS_DISPLAY,
      layout: 'board',
      group: 'health',
    });
  });

  it('reads the direction, second grouping and team and board switches', () => {
    const url: Record<string, string> = {
      direction: 'desc',
      rows: 'lead',
      lead_team: 'lead',
      empty: 'nope',
    };
    const display = resolveDisplay((field) => url[field] ?? null, {
      ...DEFAULT_PROJECTS_DISPLAY,
      empty: 'hide',
    });
    expect(display).toEqual({
      ...DEFAULT_PROJECTS_DISPLAY,
      direction: 'desc',
      rows: 'lead',
      lead_team: 'lead',
      empty: 'hide',
    });
  });

  it('falls back to the default with nothing saved', () => {
    expect(resolveDisplay(() => null, undefined)).toEqual(
      DEFAULT_PROJECTS_DISPLAY
    );
  });

  it('shows dependency lines unless the URL or the saved choice hides them', () => {
    expect(DEFAULT_PROJECTS_DISPLAY.dependencies).toBe('show');
    expect(
      resolveDisplay(() => null, {
        ...DEFAULT_PROJECTS_DISPLAY,
        dependencies: 'hide',
      }).dependencies
    ).toBe('hide');
    expect(
      resolveDisplay((field) => (field === 'dependencies' ? 'show' : null), {
        ...DEFAULT_PROJECTS_DISPLAY,
        dependencies: 'hide',
      }).dependencies
    ).toBe('show');
    expect(
      resolveDisplay((field) => (field === 'dependencies' ? 'off' : null), {
        dependencies: 'hide',
      }).dependencies
    ).toBe('hide');
  });
});

describe('URL parsing and tones', () => {
  it('falls back to the defaults for unknown values', () => {
    expect(parseGrouping('bogus')).toBe('status');
    expect(parseOrdering(null)).toBe('target');
    expect(parseGrouping('lead')).toBe('lead');
  });
});

describe('manual ordering', () => {
  const placed = (id: string, key: string | null, created = '2026-09-01') =>
    project({
      project_id: id,
      name: id,
      sort_order: key,
      created_at: `${created}T00:00:00Z`,
    });

  it('runs placed projects by key, then unplaced ones newest first', () => {
    const rows = [
      placed('old', null, '2026-09-01'),
      placed('second', 'V'),
      placed('new', null, '2026-09-05'),
      placed('first', 'F'),
    ];
    expect(sortProjects(rows, 'manual').map((row) => row.project_id)).toEqual([
      'first',
      'second',
      'new',
      'old',
    ]);
  });

  it('writes one key between placed neighbours', () => {
    const rows = [placed('a', 'F'), placed('b', 'V'), placed('c', 'k')];
    expect(manualPlacements(rows, 'c', 1)).toEqual([
      { projectId: 'c', sort_order: 'N' },
    ]);
    expect(manualPlacements(rows, 'c', 0)).toEqual([
      { projectId: 'c', sort_order: '7' },
    ]);
  });

  it('places the unplaced rows ahead of the drop point too', () => {
    const rows = [
      placed('a', 'F'),
      placed('b', null, '2026-09-05'),
      placed('c', null, '2026-09-01'),
    ];
    expect(manualPlacements(rows, 'c', 2)).toEqual([
      { projectId: 'b', sort_order: 'c' },
      { projectId: 'c', sort_order: 'o' },
    ]);
  });

  it('lands after the row shown above it in any shown order', () => {
    const rows = [placed('b', 'V'), placed('a', 'F'), placed('c', 'k')];
    expect(manualPlacements(rows, 'c', 2)).toEqual([
      { projectId: 'c', sort_order: 'N' },
    ]);
    expect(manualPlacements(rows, 'c', 1)).toEqual([]);
  });

  it('answers null for a project not among the rows', () => {
    expect(manualPlacements([placed('a', 'F')], 'z', 0)).toBeNull();
  });

  it('tells a drop that changes nothing from one the cell refuses', () => {
    const row = project({ status: 'planned' });
    const [planned] = groupProjects([row], 'status', [], []);
    if (planned === undefined) throw new Error('expected a status group');
    expect(cellChange(row, [planned])).toEqual({});
    const teamGroup = {
      key: 'team:t2',
      label: 'Other',
      kind: 'team' as const,
      rows: [],
    };
    expect(cellChange(row, [teamGroup])).toBeNull();
  });
});
