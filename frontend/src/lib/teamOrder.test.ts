/**
 * The sidebar team order helpers: a move to a new place, and a pending order
 * laid over the server's list by the same rule the server applies.
 */

import { describe, expect, it } from 'vitest';
import { applyTeamOrder, isNested, moveTeam, nestTeams } from './teamOrder';

const teams = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('moveTeam', () => {
  it('moves a team down past its neighbours', () => {
    expect(moveTeam(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('moves a team up', () => {
    expect(moveTeam(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('answers null for a move that changes nothing or leaves the list', () => {
    expect(moveTeam(['a', 'b'], 1, 1)).toBeNull();
    expect(moveTeam(['a', 'b'], 0, 2)).toBeNull();
    expect(moveTeam(['a', 'b'], -1, 0)).toBeNull();
  });
});

describe('applyTeamOrder', () => {
  it('leaves the list alone with no order', () => {
    expect(applyTeamOrder(teams, null)).toBe(teams);
  });

  it('puts named teams first and the rest after in their own order', () => {
    expect(applyTeamOrder(teams, ['c']).map((team) => team.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('ignores ids that name no team', () => {
    expect(
      applyTeamOrder(teams, ['gone', 'b', 'a']).map((team) => team.id)
    ).toEqual(['b', 'a', 'c']);
  });
});

describe('nestTeams', () => {
  it('moves each sub-team to just after its parent', () => {
    const rows = [
      { id: 'sub', parent_team_id: 'b' },
      { id: 'a', parent_team_id: null },
      { id: 'b' },
      { id: 'other', parent_team_id: 'a' },
    ];
    expect(nestTeams(rows).map((team) => team.id)).toEqual([
      'a',
      'other',
      'b',
      'sub',
    ]);
  });

  it('keeps a sub-team whose parent is not listed at the top level', () => {
    const rows = [{ id: 'a' }, { id: 'sub', parent_team_id: 'hidden' }];
    expect(nestTeams(rows).map((team) => team.id)).toEqual(['a', 'sub']);
    expect(isNested(rows[1] ?? { id: '' }, rows)).toBe(false);
    expect(isNested({ id: 'x', parent_team_id: 'a' }, rows)).toBe(true);
  });
});
