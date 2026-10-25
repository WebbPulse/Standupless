/**
 * The retired team helpers: what counts as retired, and splitting a list.
 */

import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it } from 'vitest';
import type { TeamRead } from '../types/Api';
import {
  activeTeams,
  isRetired,
  openIssueCount,
  retiredTeams,
  teamFilterTeams,
} from './teamRetirement';

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

  it('offers active teams in a team filter, plus retired ones it names', () => {
    expect(
      teamFilterTeams([live, legacy, unknown], new Set()).map((t) => t.id)
    ).toEqual(['a', 'c']);
    expect(
      teamFilterTeams([live, legacy, unknown], new Set(['b'])).map((t) => t.id)
    ).toEqual(['a', 'b', 'c']);
  });

  it('reads the open issue count from a retire refusal', () => {
    const refusal = (code: string, details: unknown): ApiError =>
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: { error_code: code, message: 'No', details },
        url: '/api/workspaces/w/teams/t/retire',
        method: 'POST',
      });
    expect(
      openIssueCount(refusal('TEAM_HAS_OPEN_ISSUES', { open_issue_count: 4 }))
    ).toBe(4);
    expect(openIssueCount(refusal('TEAM_RETIRED', {}))).toBeNull();
    expect(openIssueCount(new Error('boom'))).toBeNull();
  });
});
