/**
 * The initiatives list helpers: reading the arrangement from the URL over the
 * saved one, filtering, ordering and grouping by owner, health and target date.
 */

import { describe, expect, it } from 'vitest';
import type { InitiativeRead } from '../types/Api';
import {
  DEFAULT_INITIATIVES_DISPLAY,
  healthGroups,
  matchesInitiativeFilters,
  orderInitiatives,
  ownerGroups,
  resolveInitiativesDisplay,
  targetDateGroups,
} from './initiativeList';
import type { Assignable } from './issuePeople';

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

  it('reads the manual order and the owner, health and target date groupings', () => {
    const params = new URLSearchParams('order=manual&grouping=target_date');
    const display = resolveInitiativesDisplay(
      (field) => params.get(field),
      undefined
    );
    expect(display.order).toBe('manual');
    expect(display.grouping).toBe('target_date');
  });

  it('ignores a value it does not know', () => {
    expect(
      resolveInitiativesDisplay(
        (field) => (field === 'order' ? 'priority' : null),
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

describe('manual order', () => {
  it('runs placed initiatives by key, then unplaced ones newest first', () => {
    const rows = [
      initiative('late', { created_at: '2026-10-01T00:00:00Z' }),
      initiative('second', { sort_order: 'V' }),
      initiative('first', { sort_order: 'F' }),
      initiative('newest', { created_at: '2026-10-09T00:00:00Z' }),
    ];
    expect(
      orderInitiatives(rows, 'manual').map((row) => row.initiative_id)
    ).toEqual(['first', 'second', 'newest', 'late']);
  });
});

describe('ownerGroups', () => {
  const people = [
    {
      user_id: 'U2',
      display_name: 'Zoe',
      email: 'zoe@example.com',
    },
    {
      user_id: 'U1',
      display_name: 'Ada',
      email: 'ada@example.com',
    },
  ] as Assignable[];

  it('groups by owner by name and puts No owner last', () => {
    const groups = ownerGroups(
      [
        initiative('a', { owner_id: 'U2' }),
        initiative('b'),
        initiative('c', { owner_id: 'U1' }),
        initiative('d', { owner_id: 'U2' }),
      ],
      people
    );
    expect(groups.map((group) => group.label)).toEqual([
      'Ada',
      'Zoe',
      'No owner',
    ]);
    expect(groups[1]?.rows.map((row) => row.initiative_id)).toEqual(['a', 'd']);
  });

  it('names an owner who has left an unknown owner', () => {
    expect(
      ownerGroups([initiative('a', { owner_id: 'GONE' })], people).map(
        (group) => group.label
      )
    ).toEqual(['Unknown owner']);
  });
});

describe('healthGroups', () => {
  it('runs on track to off track and puts No health last', () => {
    const groups = healthGroups([
      initiative('a'),
      initiative('b', { health: 'off_track' }),
      initiative('c', { health: 'on_track' }),
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      'On track',
      'Off track',
      'No health',
    ]);
  });
});

describe('targetDateGroups', () => {
  it('groups by month, a coarse date after its months, and No target date last', () => {
    const groups = targetDateGroups([
      initiative('none'),
      initiative('quarter', {
        target_date: '2026-12-31',
        target_date_resolution: 'quarter',
      }),
      initiative('dec', { target_date: '2026-12-10' }),
      initiative('nov', { target_date: '2026-11-03' }),
    ]);
    expect(groups.map((group) => group.rows[0]?.initiative_id)).toEqual([
      'nov',
      'dec',
      'quarter',
      'none',
    ]);
    expect(groups.at(-1)?.label).toBe('No target date');
  });
});
