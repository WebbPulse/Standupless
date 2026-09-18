/**
 * Resolves the `:slug` in the route to a workspace and supplies it to every
 * page beneath. The contract has no read-by-slug route, so the slug is matched
 * against the caller's workspace list, which doubles as the membership check:
 * a workspace the caller cannot see is absent from the list and reads as a 404.
 */

import React, { useCallback, useMemo } from 'react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Outlet, useParams } from 'react-router-dom';
import { listWorkspaces } from '../api/workspaces';
import { useQueryAuth } from '../hooks/useQueryAuth';
import { WORKSPACES_KEY } from '../lib/queryKeys';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from './WorkspaceContextDefinition';

/** How often the workspace list is re-read while a workspace page is open. */
const WORKSPACE_POLL_MS = 60000;

/**
 * Reads the workspace list, picks the one matching the route slug and renders
 * the nested routes inside the context.
 */
export const WorkspaceProvider: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const auth = useQueryAuth();

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => listWorkspaces(signal),
    {
      intervalMs: WORKSPACE_POLL_MS,
      queryKey: WORKSPACES_KEY,
      ...(auth === undefined ? {} : { auth }),
    }
  );

  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const value = useMemo<WorkspaceContextType>(() => {
    const workspace =
      data === null || slug === undefined
        ? null
        : (data.find((item) => item.slug === slug) ?? null);
    return {
      workspace,
      isLoading,
      notFound: !isLoading && error === null && workspace === null,
      error,
      refresh,
    };
  }, [data, slug, isLoading, error, refresh]);

  return (
    <WorkspaceContext.Provider value={value}>
      <Outlet />
    </WorkspaceContext.Provider>
  );
};

export default WorkspaceProvider;
