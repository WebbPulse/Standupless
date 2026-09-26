/**
 * Reads the workspace's team list once and shares it with the sidebar, the
 * pages and the dialogs beneath, so a page load asks for it a single time and
 * a refresh anywhere reaches every surface that shows a team.
 */

import React, { useCallback, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listTeams } from '../api/teams';
import { useWorkspace } from '../hooks/useWorkspace';
import { teamsKey } from '../lib/queryKeys';
import { TeamsContext, type TeamsContextType } from './TeamsContextDefinition';

/** How often the team list is re-read while a workspace page is open. */
export const TEAMS_POLL_MS = 60000;

/**
 * Ceiling on the retry delay after a failed read. The team list is what the
 * sidebar and every picker hang off, so a read that fails on a fresh load (a
 * return from GitHub lands before the session is back) retries within
 * seconds instead of backing off for minutes.
 */
export const TEAMS_MAX_BACKOFF_MS = 10000;

/** Supplies the shared team list for the current workspace. */
export const TeamsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const workspaceId = workspace?.id ?? '';

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => listTeams(workspaceId, signal),
    {
      intervalMs: TEAMS_POLL_MS,
      maxBackoffMs: TEAMS_MAX_BACKOFF_MS,
      enabled: workspaceId !== '',
      queryKey: teamsKey(workspaceId),
      auth,
    }
  );

  const reread = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const value = useMemo<TeamsContextType>(
    () => ({ data, isLoading, error, refetch: reread }),
    [data, isLoading, error, reread]
  );

  return (
    <TeamsContext.Provider value={value}>{children}</TeamsContext.Provider>
  );
};

export default TeamsProvider;
