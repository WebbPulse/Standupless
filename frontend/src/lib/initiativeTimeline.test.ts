/**
 * The initiatives timeline rows. Covers that sub-initiatives and then linked
 * projects nest under their initiative, that a collapsed initiative hides its
 * branch while its dates still place it, that a branch with no date anywhere
 * sits in the No dates section, and that a drag sends only the dates it moved.
 */

import { describe, expect, it } from 'vitest';
import type { InitiativeRead, ProjectRead } from '../types/Api';
import {
  dragChange,
  heldDates,
  initiativeTimelineRows,
  laneDates,
} from './initiativeTimeline';
import { dayNumber } from './timeline';

/** Builds an initiative with the given parent, projects and dates. */
const node = (
  id: string,
  overrides: Partial<InitiativeRead> = {}
): InitiativeRead =>
  ({
    initiative_id: id,
    name: id.toUpperCase(),
    parent_initiative_id: null,
    ancestors: [],
    project_ids: [],
    start_date: null,
    start_date_resolution: null,
    target_date: null,
    target_date_resolution: null,
    ...overrides,
  }) as InitiativeRead;

/** Builds a project with the given dates. */
const project = (
  id: string,
  overrides: Partial<ProjectRead> = {}
): ProjectRead =>
  ({
    project_id: id,
    name: id.toUpperCase(),
    start_date: null,
    target_date: null,
    ...overrides,
  }) as ProjectRead;

/** The lanes as kind and id pairs with their depth. */
const shape = (lanes: ReturnType<typeof initiativeTimelineRows>['dated']) =>
  lanes.map((lane) =>
    lane.kind === 'initiative'
      ? [`i:${lane.initiative.initiative_id}`, lane.depth]
      : [`p:${lane.project.project_id}`, lane.depth]
  );

describe('initiativeTimelineRows', () => {
  const p1 = project('p1', { target_date: '2026-11-01' });
  const p2 = project('p2');
  const a = node('a', {
    target_date: '2026-12-01',
    project_ids: ['p2', 'p1'],
  });
  const b = node('b', { parent_initiative_id: 'a', ancestors: [] });
  const c = node('c');

  it('nests sub-initiatives and then projects under their initiative', () => {
    const rows = initiativeTimelineRows([a, b, c], [p1, p2], new Set());
    expect(shape(rows.dated)).toEqual([
      ['i:a', 0],
      ['i:b', 1],
      ['p:p1', 1],
      ['p:p2', 1],
    ]);
    expect(rows.dated[0]).toMatchObject({ childCount: 3 });
    expect(shape(rows.undated)).toEqual([['i:c', 0]]);
  });

  it('hides a collapsed branch but keeps it dated by its projects', () => {
    const undatedRoot = node('a', { project_ids: ['p1'] });
    const rows = initiativeTimelineRows([undatedRoot, b], [p1], new Set(['a']));
    expect(shape(rows.dated)).toEqual([['i:a', 0]]);
    expect(rows.undated).toEqual([]);
  });

  it('draws an orphan whose parent is filtered out as its own root', () => {
    const rows = initiativeTimelineRows([b], [], new Set());
    expect(shape(rows.undated)).toEqual([['i:b', 0]]);
  });

  it('never loops on a cycle', () => {
    const x = node('x', { parent_initiative_id: 'y' });
    const y = node('y', { parent_initiative_id: 'x' });
    const rows = initiativeTimelineRows([x, y], [], new Set());
    expect(rows.undated).toHaveLength(2);
  });

  it('lists every drawn date for the range', () => {
    const rows = initiativeTimelineRows([a], [p1], new Set());
    expect(laneDates(rows.dated)).toEqual([
      null,
      '2026-12-01',
      null,
      '2026-11-01',
    ]);
  });
});

describe('dragChange', () => {
  const next = {
    start: dayNumber('2026-11-02') ?? 0,
    end: dayNumber('2026-11-20') ?? 0,
  };

  it('sends only the start for a start drag', () => {
    expect(dragChange(node('a'), 'start', next)).toEqual({
      start_date: '2026-11-02',
    });
  });

  it('sends only the target for an end drag', () => {
    expect(dragChange(node('a'), 'end', next)).toEqual({
      target_date: '2026-11-20',
    });
  });

  it('moves only the dates an initiative holds', () => {
    const targetOnly = node('a', { target_date: '2026-11-10' });
    expect(dragChange(targetOnly, 'move', next)).toEqual({
      target_date: '2026-11-20',
    });
    const both = node('a', {
      start_date: '2026-11-01',
      target_date: '2026-11-10',
    });
    expect(dragChange(both, 'move', next)).toEqual({
      start_date: '2026-11-02',
      target_date: '2026-11-20',
    });
    const startOnly = node('a', { start_date: '2026-11-01' });
    expect(dragChange(startOnly, 'move', next)).toEqual({
      start_date: '2026-11-02',
    });
  });

  it('holds every date for an undo', () => {
    const held = node('a', {
      start_date: '2026-10-01',
      start_date_resolution: 'quarter',
      target_date: '2026-12-31',
    });
    expect(heldDates(held)).toEqual({
      start_date: '2026-10-01',
      start_date_resolution: 'quarter',
      target_date: '2026-12-31',
      target_date_resolution: null,
    });
  });
});
