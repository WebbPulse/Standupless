/**
 * The initiatives list helpers: reading the arrangement from the URL over the
 * saved one, filtering and ordering.
 */

import { describe, expect, it } from 'vitest';
import type { InitiativeRead } from '../types/Api';
import {
  DEFAULT_INITIATIVES_DISPLAY,
  matchesInitiativeFilters,
  orderInitiatives,
  resolveInitiativesDisplay,
} from './initiativeList';

/** An initiative carrying only what the helpers read. */
const initiative = (
  id: string,
  overrides: Partial<InitiativeRead> = {}
): InitiativeRead =>
  ({
    initiative_id: id,
    name: id,
    owner_id: null,
    status: 'planned',
    health: null,
    target_date: null,
    counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  }) as InitiativeRead;

describe('resolveInitiativesDisplay', () => {
  it('reads the URL first, then the saved arrangement, then the default', () => {
    const params = new URLSearchParams('order=name&columns=progress,owner');
    expect(
      resolveInitiativesDisplay((field) => params.get(field), {
        order: 'created',
        completed: 'hide',
      })
    ).toEqual({
      grouping: 'status',
      order: 'name',
      completed: 'hide',
      columns: 'owner,progress',
    });
  });

  it('reads the team grouping from the URL', () => {
    const params = new URLSearchParams('grouping=team');
    expect(
      resolveInitiativesDisplay((field) => params.get(field), undefined)
        .grouping
    ).toBe('team');
  });

  it('ignores a value it does not know', () => {
    expect(
      resolveInitiativesDisplay(
        (field) => (field === 'order' ? 'manual' : null),
        undefined
      )
    ).toEqual(DEFAULT_INITIATIVES_DISPLAY);
  });
});

describe('matchesInitiativeFilters', () => {
  it('matches a lead team or no team', () => {
    const led = initiative('led', { team_id: 'T1' });
    const open = initiative('open');
    const filters = { status: [], owner: '', health: [] };
    expect(matchesInitiativeFilters(led, { ...filters, team: 'T1' })).toBe(
      true
    );
    expect(matchesInitiativeFilters(open, { ...filters, team: 'T1' })).toBe(
      false
    );
    expect(matchesInitiativeFilters(open, { ...filters, team: 'none' })).toBe(
      true
    );
    expect(matchesInitiativeFilters(led, { ...filters, team: '' })).toBe(true);
  });

  it('matches no owner and no health', () => {
    const row = initiative('a');
    expect(
      matchesInitiativeFilters(row, {
        status: [],
        owner: 'none',
        health: ['none'],
      })
    ).toBe(true);
    expect(
      matchesInitiativeFilters(row, {
        status: ['active'],
        owner: '',
        health: [],
      })
    ).toBe(false);
  });
});

describe('orderInitiatives', () => {
  it('runs target dates soonest first with undated ones last', () => {
    const rows = [
      initiative('c'),
      initiative('b', { target_date: '2026-12-01' }),
      initiative('a', { target_date: '2026-11-01' }),
    ];
    expect(
      orderInitiatives(rows, 'target').map((row) => row.initiative_id)
    ).toEqual(['a', 'b', 'c']);
  });

  it('runs the most recently updated first', () => {
    const rows = [
      initiative('a', { updated_at: '2026-10-01T00:00:00Z' }),
      initiative('b', { updated_at: '2026-10-05T00:00:00Z' }),
    ];
    expect(
      orderInitiatives(rows, 'updated').map((row) => row.initiative_id)
    ).toEqual(['b', 'a']);
  });
});
