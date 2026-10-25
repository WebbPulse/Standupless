/**
 * The projects page's property filters. Covers reading them from the URL over
 * an open view's, dropping values the route would refuse, the round trip
 * through a saved view's filter, and what each filter keeps of a project row:
 * `none` for no health or members, exclusive date bounds that skip undated
 * projects, and update age with a never updated project counted as stale.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectRead } from '../types/Api';
import {
  EMPTY_PROPERTY_FILTERS,
  hasPropertyFilters,
  matchesPropertyFilters,
  propertyFiltersFromView,
  propertyFiltersToView,
  readPropertyFilters,
  samePropertyFilters,
  type ProjectPropertyFilters,
} from './projectPropertyFilters';

const NOW = new Date('2026-10-25T12:00:00Z');

const project: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: '2026-09-01',
  name: 'Launch',
  description: null,
  target_date: '2026-11-01',
  status: 'in_progress',
  icon: null,
  color: null,
  health: 'at_risk',
  priority: 'high',
  member_ids: ['user-1'],
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  last_update_at: '2026-10-20T12:00:00Z',
};

const filters = (
  set: Partial<ProjectPropertyFilters>
): ProjectPropertyFilters => ({ ...EMPTY_PROPERTY_FILTERS, ...set });

const keeps = (
  set: Partial<ProjectPropertyFilters>,
  row: ProjectRead = project
): boolean => matchesPropertyFilters(row, filters(set), NOW);

describe('readPropertyFilters', () => {
  it('reads each filter from the URL and drops what the route refuses', () => {
    const read = readPropertyFilters(
      new URLSearchParams(
        'health=at_risk,sunny&priority=high&member=user-1,none&start_before=2026-12-01&target_after=June&updated_within=0&not_updated_within=14'
      )
    );
    expect(read).toEqual(
      filters({
        health: ['at_risk'],
        priority: ['high'],
        member: ['user-1', 'none'],
        startBefore: '2026-12-01',
        notUpdatedWithin: '14',
      })
    );
  });

  it('falls back to the open view and lets an empty param clear it', () => {
    const base = filters({ health: ['off_track'], updatedWithin: '7' });
    expect(readPropertyFilters(new URLSearchParams(''), base)).toEqual(base);
    expect(readPropertyFilters(new URLSearchParams('health='), base)).toEqual(
      filters({ updatedWithin: '7' })
    );
  });
});

describe('saved view round trip', () => {
  it('stores only the set filters under the route names and reads them back', () => {
    const held = filters({
      health: ['none'],
      member: ['user-1'],
      targetBefore: '2026-12-31',
      notUpdatedWithin: '30',
    });
    const stored = propertyFiltersToView(held);
    expect(stored).toEqual({
      health: ['none'],
      member_id: ['user-1'],
      target_date_before: '2026-12-31',
      not_updated_within_days: '30',
    });
    expect(propertyFiltersFromView(stored)).toEqual(held);
    expect(propertyFiltersToView(EMPTY_PROPERTY_FILTERS)).toEqual({});
  });

  it('compares lists without regard to order', () => {
    expect(
      samePropertyFilters(
        { health: ['at_risk', 'off_track'] },
        { health: ['off_track', 'at_risk'] }
      )
    ).toBe(true);
    expect(samePropertyFilters({ health: ['at_risk'] }, {})).toBe(false);
  });

  it('knows when any filter is set', () => {
    expect(hasPropertyFilters(EMPTY_PROPERTY_FILTERS)).toBe(false);
    expect(hasPropertyFilters(filters({ startAfter: '2026-01-01' }))).toBe(
      true
    );
  });
});

describe('matchesPropertyFilters', () => {
  it('keeps a named health and reads none as no health', () => {
    expect(keeps({ health: ['at_risk'] })).toBe(true);
    expect(keeps({ health: ['on_track'] })).toBe(false);
    expect(keeps({ health: ['none'] }, { ...project, health: null })).toBe(
      true
    );
  });

  it('keeps a named priority', () => {
    expect(keeps({ priority: ['high', 'urgent'] })).toBe(true);
    expect(keeps({ priority: ['none'] })).toBe(false);
  });

  it('keeps any named member and reads none as no members', () => {
    expect(keeps({ member: ['user-1'] })).toBe(true);
    expect(keeps({ member: ['user-2'] })).toBe(false);
    expect(keeps({ member: ['none'] }, { ...project, member_ids: [] })).toBe(
      true
    );
  });

  it('bounds the dates exclusively and skips an undated project', () => {
    expect(keeps({ startAfter: '2026-08-31' })).toBe(true);
    expect(keeps({ startAfter: '2026-09-01' })).toBe(false);
    expect(keeps({ targetBefore: '2026-11-01' })).toBe(false);
    expect(keeps({ targetBefore: '2026-11-02' })).toBe(true);
    expect(
      keeps({ startBefore: '2027-01-01' }, { ...project, start_date: null })
    ).toBe(false);
  });

  it('measures update age from the newest project update', () => {
    expect(keeps({ updatedWithin: '7' })).toBe(true);
    expect(keeps({ updatedWithin: '1' })).toBe(false);
    expect(keeps({ notUpdatedWithin: '1' })).toBe(true);
    expect(keeps({ notUpdatedWithin: '7' })).toBe(false);
    const never = { ...project, last_update_at: null };
    expect(keeps({ notUpdatedWithin: '7' }, never)).toBe(true);
    expect(keeps({ updatedWithin: '7' }, never)).toBe(false);
  });

  it('combines every set filter', () => {
    expect(
      keeps({
        health: ['at_risk'],
        priority: ['high'],
        member: ['user-1'],
        targetAfter: '2026-10-01',
        updatedWithin: '30',
      })
    ).toBe(true);
    expect(keeps({ health: ['at_risk'], priority: ['low'] })).toBe(false);
  });
});
