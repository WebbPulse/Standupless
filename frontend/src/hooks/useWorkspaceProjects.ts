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
 * Reads the projects, narrowed to one team when `teamId` is not empty. Stops
 * on a repeated cursor rather than looping on it.
 */
export const useWorkspaceProjects = (
  workspaceId: string,
  teamId: string,
  enabled = true
): WorkspaceProjects => {
  const auth = useQueryAuth();
  const queryKey = projectsKey(workspaceId, teamId, '');

  const read = useCallback(
    async ({ signal }: { signal?: AbortSignal }) => {
      const projects: ProjectRead[] = [];
      let cursor: string | null = null;
      do {
        const page = await listProjects(
          workspaceId,
          {
            ...(teamId === '' ? {} : { team_id: teamId }),
            ...(cursor === null ? {} : { cursor }),
          },
          signal
        );
        projects.push(...page.projects);
        if (page.next_cursor !== null && page.next_cursor === cursor) break;
        cursor = page.next_cursor;
      } while (cursor !== null);
      return projects;
    },
    [workspaceId, teamId]
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
