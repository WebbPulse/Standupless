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
import type { ProjectRead } from '../types/Api';

/** How often the projects re-read. */
const POLL_MS = 60000;

/** What {@link useWorkspaceProjects} hands back. */
export interface WorkspaceProjects {
  projects: ProjectRead[];
  error: unknown;
  isLoading: boolean;
  /** The key the read runs under, for a write to invalidate. */
  queryKey: QueryKey;
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
  includeSubTeams = false
): Promise<ProjectRead[]> => {
  const projects: ProjectRead[] = [];
  let cursor: string | null = null;
  do {
    const page = await listProjects(
      workspaceId,
      {
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
 * its visible sub-teams' projects too when `includeSubTeams` is set.
 */
export const useWorkspaceProjects = (
  workspaceId: string,
  teamId: string,
  enabled = true,
  includeSubTeams = false
): WorkspaceProjects => {
  const auth = useQueryAuth();
  const rollUp = teamId !== '' && includeSubTeams;
  const queryKey = projectsKey(
    workspaceId,
    rollUp ? `${teamId}:sub-teams` : teamId,
    ''
  );

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listAllProjects(workspaceId, teamId, signal, rollUp),
    [workspaceId, teamId, rollUp]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '',
    queryKey,
    auth,
  });

  return { projects: data ?? [], error, isLoading, queryKey };
};

export default useWorkspaceProjects;
