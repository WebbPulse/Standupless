/**
 * Every project the caller can see, or the projects of one team, read to the
 * end of the cursor. The projects list and the roadmap group, filter and draw
 * the whole set at once, and a workspace holds tens of projects rather than
 * thousands, so they follow the cursor in one read instead of paging on
 * request.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import { listProjects } from '../api/planning';
import { projectsKey } from '../lib/queryKeys';
import { useLiveQueryKey } from '../lib/realtime';
import type {
  ProjectListQuery,
  ProjectRead,
  ProjectSortField,
} from '../types/Api';

/** How often the projects re-read. */
const POLL_MS = 60000;

/** The customer filter and sort the server applies, which only the projects page asks for. */
export type ProjectNarrowing = Pick<
  ProjectListQuery,
  'customer_id' | 'customer_id_not' | 'sort' | 'include_archived'
>;

/** What {@link useWorkspaceProjects} hands back. */
export interface WorkspaceProjects {
  projects: ProjectRead[];
  error: unknown;
  isLoading: boolean;
  /** The key the read runs under, for a write to invalidate. */
  queryKey: QueryKey;
  /** Reads the projects again now, for a retry after a failed read. */
  refetch: () => void;
}

/**
 * Reads every project to the end of the cursor, narrowed to one team when
 * `teamId` is not empty, and to that team with its visible sub-teams when
 * `includeSubTeams` is set. Stops on a repeated cursor rather than looping on it.
 * The workspace wide read is the one every surface shares, so callers that
 * need several teams' projects filter it rather than reading per team.
 */
export const listAllProjects = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal,
  includeSubTeams = false,
  narrowing: ProjectNarrowing = {}
): Promise<ProjectRead[]> => {
  const projects: ProjectRead[] = [];
  let cursor: string | null = null;
  do {
    const page = await listProjects(
      workspaceId,
      {
        ...narrowing,
        ...(teamId === '' ? {} : { team_id: teamId }),
        ...(teamId !== '' && includeSubTeams
          ? { include_sub_teams: true }
          : {}),
        ...(cursor === null ? {} : { cursor }),
      },
      signal
    );
    projects.push(...page.projects);
    if (page.next_cursor !== null && page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  } while (cursor !== null);
  return projects;
};

/**
 * Reads the projects, narrowed to one team when `teamId` is not empty, with
 * its visible sub-teams' projects too when `includeSubTeams` is set, and by
 * customer or in customer order when `narrowing` asks.
 */
export const useWorkspaceProjects = (
  workspaceId: string,
  teamId: string,
  enabled = true,
  includeSubTeams = false,
  narrowing: ProjectNarrowing = {}
): WorkspaceProjects => {
  const auth = useQueryAuth();
  const rollUp = teamId !== '' && includeSubTeams;
  const narrowingKey = JSON.stringify([
    narrowing.customer_id ?? [],
    narrowing.customer_id_not ?? [],
    narrowing.sort ?? '',
    narrowing.include_archived === true,
  ]);
  const queryKey = projectsKey(
    workspaceId,
    rollUp ? `${teamId}:sub-teams` : teamId,
    narrowingKey === '[[],[],"",false]' ? '' : narrowingKey
  );

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) => {
      const [customerIds, customerIdsNot, sort, includeArchived] = JSON.parse(
        narrowingKey
      ) as [string[], string[], string, boolean];
      return listAllProjects(workspaceId, teamId, signal, rollUp, {
        ...(customerIds.length === 0 ? {} : { customer_id: customerIds }),
        ...(customerIdsNot.length === 0
          ? {}
          : { customer_id_not: customerIdsNot }),
        ...(sort === '' ? {} : { sort: sort as ProjectSortField }),
        ...(includeArchived ? { include_archived: true } : {}),
      });
    },
    [workspaceId, teamId, rollUp, narrowingKey]
  );

  useLiveQueryKey(queryKey, enabled && workspaceId !== '');
  const { data, error, isLoading, refetch } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '',
    queryKey,
    auth,
  });

  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return { projects: data ?? [], error, isLoading, queryKey, refetch: retry };
};

export default useWorkspaceProjects;
