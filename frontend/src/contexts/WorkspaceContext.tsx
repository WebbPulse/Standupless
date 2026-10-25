/**
 * Resolves the `:slug` in the route to a workspace and supplies it to every
 * page beneath. The contract has no read-by-slug route, so the slug is matched
 * against the caller's workspace list, which doubles as the membership check:
 * a workspace the caller cannot see is absent from the list and reads as a 404.
 * A slug the workspace has retired redirects to the same page under its
 * current slug, keeping the rest of the path, the query and the hash, so a
 * link shared before a slug change still opens what it pointed at.
 * It also paints the workspace's accent color over every page beneath, and
 * stands the auth policy gate in for the pages when the caller's session does
 * not meet the workspace's two-factor requirement. A re-read that answers the
 * same workspaces hands back the list held, so the rows of a long issue list,
 * which each read the workspace, do not render again for it.
 */

import React, { useCallback, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { listWorkspaces } from '../api/workspaces';
import AuthPolicyGate from '../components/workspace/AuthPolicyGate';
import { useSharedValue } from '../hooks/useSharedValue';
import { useWorkspaceAccent } from '../hooks/useWorkspaceAccent';
import { WORKSPACES_KEY } from '../lib/queryKeys';
import { pathWithSlug, workspaceRetiring } from '../lib/workspaceSlug';
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
  const location = useLocation();
  const auth = useQueryAuth();

  const {
    data: read,
    error,
    isLoading,
    refetch,
  } = usePolledQuery(({ signal }) => listWorkspaces(signal), {
    intervalMs: WORKSPACE_POLL_MS,
    queryKey: WORKSPACES_KEY,
    auth,
  });

  const data = useSharedValue(read);

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
      workspaces: data ?? [],
      isLoading,
      notFound: !isLoading && error === null && workspace === null,
      error,
      refresh,
    };
  }, [data, slug, isLoading, error, refresh]);

  const moved =
    value.workspace === null && data !== null && slug !== undefined
      ? workspaceRetiring(data, slug)
      : null;

  useWorkspaceAccent(value.workspace, value.notFound && moved === null);

  if (moved !== null && slug !== undefined) {
    return (
      <Navigate
        replace
        to={pathWithSlug(
          location.pathname,
          location.search,
          location.hash,
          slug,
          moved.slug
        )}
      />
    );
  }

  return (
    <WorkspaceContext.Provider value={value}>
      {value.workspace?.auth_policy_blocked === true ? (
        <AuthPolicyGate workspace={value.workspace} onRetry={refresh} />
      ) : (
        <Outlet />
      )}
    </WorkspaceContext.Provider>
  );
};

export default WorkspaceProvider;
