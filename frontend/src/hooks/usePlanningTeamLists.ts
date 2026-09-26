/**
 * The statuses, labels and people of several teams at once, for a project or
 * cycle page whose issues can come from any of its teams. Each list is one
 * polled read that fans out over the teams, because the number of teams is
 * only known at runtime and a hook cannot be called in a loop.
 */

import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listLabels, listStatuses, listTeamMembers } from '../api/teams';
import type { Assignable } from '../lib/issuePeople';
import type { LabelRead, StatusRead } from '../types/Api';

/** How often the lists are re-read. */
const POLL_MS = 60000;

/** The merged lists, empty until each read lands. */
export interface PlanningTeamLists {
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
}

/** Which lists a caller needs. Each defaults to read. */
export interface PlanningTeamNeeds {
  statuses?: boolean;
  labels?: boolean;
  people?: boolean;
}

/** Drops a repeated row, keeping the first, by the key the caller names. */
const unique = <T>(rows: T[], key: (row: T) => string): T[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = key(row);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/**
 * Reads and merges the lists of every named team. An empty team list reads
 * nothing, so a page can mount this before it knows the teams.
 */
export const usePlanningTeamLists = (
  workspaceId: string,
  teamIds: string[],
  needs: PlanningTeamNeeds = {}
): PlanningTeamLists => {
  const auth = useQueryAuth();
  const ids = [...new Set(teamIds)].sort();
  const enabled = workspaceId !== '' && ids.length > 0;
  const joined = ids.join(',');

  const { data: statuses } = usePolledQuery(
    async ({ signal }) =>
      (
        await Promise.all(
          ids.map((teamId) => listStatuses(workspaceId, teamId, signal))
        )
      ).flat(),
    {
      intervalMs: POLL_MS,
      enabled: enabled && needs.statuses !== false,
      queryKey: ['planningStatuses', workspaceId, joined],
      auth,
    }
  );

  const { data: labels } = usePolledQuery(
    async ({ signal }) =>
      (
        await Promise.all(
          ids.map((teamId) => listLabels(workspaceId, teamId, signal))
        )
      ).flat(),
    {
      intervalMs: POLL_MS,
      enabled: enabled && needs.labels !== false,
      queryKey: ['planningLabels', workspaceId, joined],
      auth,
    }
  );

  const { data: people } = usePolledQuery(
    async ({ signal }) =>
      unique(
        (
          await Promise.all(
            ids.map((teamId) => listTeamMembers(workspaceId, teamId, signal))
          )
        ).flat(),
        (person) => person.user_id
      ),
    {
      intervalMs: POLL_MS,
      enabled: enabled && needs.people !== false,
      queryKey: ['planningPeople', workspaceId, joined],
      auth,
    }
  );

  return {
    statuses: statuses ?? [],
    labels: labels ?? [],
    people: people ?? [],
  };
};

export default usePlanningTeamLists;
