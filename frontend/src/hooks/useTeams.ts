/**
 * Accessor for the workspace's team list. Under the workspace layout it reads
 * the one shared list; anywhere else, such as a page rendered on its own in a
 * test, it reads the list itself so the caller still gets teams.
 */

import { useContext } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listTeams } from '../api/teams';
import {
  TeamsContext,
  type TeamsContextType,
} from '../contexts/TeamsContextDefinition';
import { teamsKey } from '../lib/queryKeys';
import { useWorkspace } from './useWorkspace';

/** How often the fallback read re-reads the list. */
const POLL_MS = 60000;

/** The team list with the workspace it belongs to. */
export type UseTeamsResult = TeamsContextType & { workspaceId: string };

/**
 * Returns the team list of a workspace given by id, for a component handed
 * its workspace as a prop. `enabled` gates only its own read; the shared list
 * is read regardless.
 */
export const useTeamsFor = (
  workspaceId: string,
  enabled = true
): UseTeamsResult => {
  const shared = useContext(TeamsContext);
  const auth = useQueryAuth();

  const own = usePolledQuery(({ signal }) => listTeams(workspaceId, signal), {
    intervalMs: POLL_MS,
    enabled: enabled && shared === undefined && workspaceId !== '',
    queryKey: teamsKey(workspaceId),
    auth,
  });

  if (shared !== undefined) return { ...shared, workspaceId };
  return {
    data: own.data,
    isLoading: own.isLoading,
    error: own.error,
    refetch: async () => {
      await own.refetch();
    },
    workspaceId,
  };
};

/** Returns the current route's workspace team list. */
export const useTeams = (): UseTeamsResult => {
  const { workspace } = useWorkspace();
  return useTeamsFor(workspace?.id ?? '');
};

export default useTeams;
