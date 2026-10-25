/**
 * The mapping between a saved view of projects and the projects page. Covers
 * reading a stored team id as the page's key prefix, a single value or a list,
 * the blocked and blocking flags and the roll-up switch; keeping a team the caller cannot see; and saving
 * only what narrows the page, compared the same way whatever order it holds.
 */

import { describe, expect, it } from 'vitest';
import type { SavedViewDisplayRead } from '../api/views';
import type { TeamRead } from '../types/Api';
import { DEFAULT_PROJECTS_DISPLAY } from './projectList';
import {
  projectViewBase,
  sameProjectFilter,
  toProjectViewFilter,
} from './projectView';

const engine: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

/** A view of projects holding the given filter and arrangement. */
const stored = (
  filter: Record<string, unknown>,
  display: SavedViewDisplayRead['projects_display'] = null
): Pick<SavedViewDisplayRead, 'filter' | 'projects_display'> => ({
  filter,
  projects_display: display,
});

describe('projectViewBase', () => {
  it('reads the stored team as its key prefix and a lone value as a list', () => {
    const base = projectViewBase(
      stored({
        team_id: 'team-1',
        status: 'planned',
        lead_id: 'user-1',
        sub_teams: 'false',
        is_blocked: 'true',
        is_blocking: 'false',
      }),
      [engine]
    );

    expect(base).toEqual({
      team: 'ENG',
      teamId: 'team-1',
      status: ['planned'],
      lead: 'user-1',
      blocked: 'true',
      blocking: 'false',
      rollUp: false,
      customer: '',
      label: '',
      display: DEFAULT_PROJECTS_DISPLAY,
    });
  });

  it('keeps a team the caller cannot see so the page matches nothing', () => {
    const base = projectViewBase(stored({ team_id: 'team-9' }), [engine]);

    expect(base.team).toBe('team-9');
    expect(base.teamId).toBe('team-9');
    expect(base.rollUp).toBe(true);
  });

  it('orders the statuses and takes the stored arrangement', () => {
    const base = projectViewBase(
      stored(
        { status: ['completed', 'planned', 'retired'] },
        {
          layout: 'board',
          group: 'lead',
          order: 'name',
          closed: 'none',
          zoom: 'year',
          columns: 'status,health',
        }
      ),
      []
    );

    expect(base.status).toEqual(['planned', 'completed']);
    expect(base.display).toEqual({
      layout: 'board',
      group: 'lead',
      direction: 'asc',
      rows: 'none',
      order: 'name',
      closed: 'none',
      lead_team: 'all',
      empty: 'show',
      zoom: 'year',
      dependencies: 'show',
      columns: 'health,status',
    });
  });

  it('shows the default columns for a view saved before columns could be chosen', () => {
    const base = projectViewBase(
      stored(
        {},
        {
          layout: 'list',
          group: 'status',
          order: 'target',
          closed: 'all',
          zoom: 'month',
        }
      ),
      []
    );

    expect(base.display.columns).toBe(DEFAULT_PROJECTS_DISPLAY.columns);
    expect(base.blocked).toBe('');
    expect(base.blocking).toBe('');
  });
});

describe('toProjectViewFilter', () => {
  it('stores only what narrows the page', () => {
    expect(
      toProjectViewFilter({
        teamId: '',
        status: [],
        lead: '',
        blocked: '',
        blocking: '',
        rollUp: false,
      })
    ).toEqual({});
    expect(
      toProjectViewFilter({
        teamId: 'team-1',
        status: ['paused', 'planned'],
        lead: 'none',
        blocked: 'true',
        blocking: 'false',
        rollUp: false,
      })
    ).toEqual({
      team_id: 'team-1',
      status: ['planned', 'paused'],
      lead_id: ['none'],
      is_blocked: 'true',
      is_blocking: 'false',
      sub_teams: 'false',
    });
  });

  it('stores a customer filter as a list', () => {
    expect(
      toProjectViewFilter({
        teamId: '',
        status: [],
        lead: '',
        blocked: '',
        blocking: '',
        rollUp: true,
        customer: 'customer-1',
      })
    ).toEqual({ customer_id: ['customer-1'] });
  });

  it('stores a project label filter as a list and reads it back', () => {
    const filter = toProjectViewFilter({
      teamId: '',
      status: [],
      lead: '',
      blocked: '',
      blocking: '',
      rollUp: true,
      label: 'label-1',
    });

    expect(filter).toEqual({ label_id: ['label-1'] });
    expect(projectViewBase(stored({ ...filter }), []).label).toBe('label-1');
  });
});

describe('sameProjectFilter', () => {
  it('compares statuses and leads whatever shape they are stored in', () => {
    expect(
      sameProjectFilter(
        { status: 'planned', lead_id: 'user-1' },
        { status: ['planned'], lead_id: ['user-1'], sub_teams: 'true' }
      )
    ).toBe(true);
    expect(
      sameProjectFilter({ status: ['planned'] }, { status: ['paused'] })
    ).toBe(false);
    expect(sameProjectFilter({ is_blocked: 'true' }, {})).toBe(false);
    expect(
      sameProjectFilter({ is_blocking: 'false' }, { is_blocking: 'false' })
    ).toBe(true);
    expect(
      sameProjectFilter({ customer_id: 'customer-1' }, { customer_id: [] })
    ).toBe(false);
  });
});
