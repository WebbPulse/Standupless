/**
 * The retired team helpers: what counts as retired, and splitting a list.
 */

import { describe, expect, it } from 'vitest';
import { activeTeams, isRetired, retiredTeams } from './teamRetirement';

describe('teamRetirement', () => {
  const live = { id: 'a', retired_at: null };
  const legacy = { id: 'b', retired_at: '2026-10-25T00:00:00Z' };
  const unknown = { id: 'c' };

  it('reads a team with a retired_at as retired', () => {
    expect(isRetired(legacy)).toBe(true);
    expect(isRetired(live)).toBe(false);
    expect(isRetired(unknown)).toBe(false);
  });

  it('splits a list into active and retired teams, keeping order', () => {
    expect(activeTeams([live, legacy, unknown]).map((t) => t.id)).toEqual([
      'a',
      'c',
    ]);
    expect(retiredTeams([live, legacy, unknown]).map((t) => t.id)).toEqual([
      'b',
    ]);
  });
});
