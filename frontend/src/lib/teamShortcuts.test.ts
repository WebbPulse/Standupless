/**
 * The Ctrl+Shift+digit team shortcuts number the teams the way the sidebar
 * lists them.
 */

import { describe, expect, it } from 'vitest';
import {
  isTeamShortcutKeys,
  sidebarTeamOrder,
  teamAtPosition,
  teamShortcutKeys,
} from './teamShortcuts';

/** A team as the sidebar reads it. */
const team = (
  id: string,
  extra: {
    private?: boolean;
    is_member?: boolean;
    parent_team_id?: string | null;
    retired_at?: string | null;
  } = {}
) => ({ id, key_prefix: id.toUpperCase(), ...extra });

describe('sidebarTeamOrder', () => {
  it('keeps the saved order the server returns', () => {
    const teams = [team('c'), team('a'), team('b')];

    expect(sidebarTeamOrder(teams).map((row) => row.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('puts each sub-team right after its parent', () => {
    const teams = [team('a'), team('b'), team('a1', { parent_team_id: 'a' })];

    expect(sidebarTeamOrder(teams).map((row) => row.id)).toEqual([
      'a',
      'a1',
      'b',
    ]);
  });

  it('leaves out retired teams and private teams the viewer is not in', () => {
    const teams = [
      team('a', { retired_at: '2026-10-01T00:00:00Z' }),
      team('b', { private: true, is_member: false }),
      team('c', { private: true, is_member: true }),
      team('d'),
    ];

    expect(sidebarTeamOrder(teams).map((row) => row.id)).toEqual(['c', 'd']);
  });
});

describe('teamAtPosition', () => {
  const teams = Array.from({ length: 10 }, (_, index) =>
    team(`t${String(index + 1)}`)
  );

  it('answers the team at a 1-based position', () => {
    expect(teamAtPosition(teams, 1)?.id).toBe('t1');
    expect(teamAtPosition(teams, 9)?.id).toBe('t9');
  });

  it('answers nothing past the ninth team or past the last one', () => {
    expect(teamAtPosition(teams, 10)).toBeUndefined();
    expect(teamAtPosition(teams.slice(0, 2), 3)).toBeUndefined();
    expect(teamAtPosition(teams, 0)).toBeUndefined();
  });
});

describe('teamShortcutKeys', () => {
  it('binds Ctrl and Shift with the digit', () => {
    expect(teamShortcutKeys(4)).toBe('ctrl+shift+4');
    expect(isTeamShortcutKeys('ctrl+shift+4')).toBe(true);
    expect(isTeamShortcutKeys('mod+shift+4')).toBe(false);
  });
});
