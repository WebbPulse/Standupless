/**
 * The retired team helpers: what counts as retired, and splitting a list.
 */

import { describe, expect, it } from 'vitest';
import type { TeamRead } from '../types/Api';
import { activeTeams, isRetired, retiredTeams } from './teamRetirement';

/** The fields the helpers read, plus an id to tell the samples apart. */
type Sample = Pick<TeamRead, 'id' | 'retired_at'>;

describe('teamRetirement', () => {
  const live: Sample = { id: 'a', retired_at: null };
  const legacy: Sample = { id: 'b', retired_at: '2026-10-25T00:00:00Z' };
  const unknown: Sample = { id: 'c' };

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
