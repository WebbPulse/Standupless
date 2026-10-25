/**
 * Which project labels and statuses a project is offered: the workspace's
 * always, a team's only to the projects on that team, and the ordering that
 * puts the workspace's statuses ahead of a team's within a category.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectStatusRead } from '../types/Api';
import {
  type ScopedEntry,
  isOfferedTo,
  isWorkspaceEntry,
  offeredToTeams,
  teamEntryCounts,
} from './projectScopes';
import { defaultStatusFor, orderProjectStatuses } from './projectStatuses';

/** A scoped entry with an id to name it by. */
interface Entry extends ScopedEntry {
  id: string;
}

const shared: Entry = { id: 'shared', team_id: null };
const legacy: Entry = { id: 'legacy' };
const mine: Entry = { id: 'mine', team_id: 'team-a' };
const theirs: Entry = { id: 'theirs', team_id: 'team-b' };
const entries: Entry[] = [shared, legacy, mine, theirs];

/** One status row with only the fields ordering reads set apart. */
const status = (
  id: string,
  position: number,
  teamId: string | null,
  isDefault = false
): ProjectStatusRead => ({
  id,
  name: id,
  category: 'in_progress',
  color: null,
  description: null,
  position,
  is_default: isDefault,
  project_count: 0,
  team_id: teamId,
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
});

describe('project scopes', () => {
  it('treats an entry with no team as the workspace own', () => {
    expect(isWorkspaceEntry(shared)).toBe(true);
    expect(isWorkspaceEntry(legacy)).toBe(true);
    expect(isWorkspaceEntry(mine)).toBe(false);
  });

  it('offers the workspace entries and only the given teams', () => {
    expect(offeredToTeams(entries, ['team-a']).map((row) => row.id)).toEqual([
      'shared',
      'legacy',
      'mine',
    ]);
    expect(offeredToTeams(entries, []).map((row) => row.id)).toEqual([
      'shared',
      'legacy',
    ]);
  });

  it('judges one entry against a project teams, leaving an unread one to the server', () => {
    expect(isOfferedTo(mine, ['team-a'])).toBe(true);
    expect(isOfferedTo(theirs, ['team-a'])).toBe(false);
    expect(isOfferedTo(shared, [])).toBe(true);
    expect(isOfferedTo(undefined, [])).toBe(true);
  });

  it('counts the entries each team keeps of its own', () => {
    expect(teamEntryCounts([...entries, mine])).toEqual(
      new Map([
        ['team-a', 2],
        ['team-b', 1],
      ])
    );
  });

  it('orders a category with the workspace statuses ahead of a team', () => {
    const ordered = orderProjectStatuses([
      status('review', 0, 'team-a'),
      status('started', 1, null),
      status('qa', 1, 'team-a'),
      status('in_progress', 0, null, true),
    ]);
    expect(ordered.map((row) => row.id)).toEqual([
      'in_progress',
      'started',
      'review',
      'qa',
    ]);
  });

  it('falls back to a workspace status, never a team one, for a category default', () => {
    const rows = [status('review', 0, 'team-a'), status('started', 1, null)];
    expect(defaultStatusFor(rows, 'in_progress').id).toBe('started');
  });
});
