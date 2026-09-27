/**
 * The projects list's ordering and grouping. Covers that dates run soonest
 * first with undated rows last, that ties fall back to the name, that lead
 * groups put "No lead" last, and that a project on two teams shows under both.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectRead, TeamRead } from '../types/Api';
import {
  groupProjects,
  parseGrouping,
  parseOrdering,
  sortProjects,
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

  it('orders by name', () => {
    expect(names(sortProjects(rows, 'name'))).toEqual([
      'Done',
      'Early',
      'Late',
      'Undated',
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

describe('URL parsing and tones', () => {
  it('falls back to the defaults for unknown values', () => {
    expect(parseGrouping('bogus')).toBe('status');
    expect(parseOrdering(null)).toBe('target');
    expect(parseGrouping('lead')).toBe('lead');
  });
});
