/**
 * Accessors for the sidebar's reads. Under the workspace layout each returns
 * the shared value, which outlives the page; anywhere else, such as a sidebar
 * rendered on its own in a test, each reads for itself.
 */

import { useContext } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getTriageSummary } from '../api/triage';
import {
  getInboxCount,
  listViews,
  type SavedViewDisplayRead,
} from '../api/views';
import {
  SidebarDataContext,
  type SidebarDataContextType,
} from '../contexts/SidebarDataContextDefinition';
import { inboxCountKey, triageSummaryKey, viewsKey } from '../lib/queryKeys';
import type { TriageSummaryRead } from '../types/Api';

/** How often a fallback read repeats. */
const POLL_MS = 60000;

/** The shared reads when they belong to `workspaceId`, otherwise undefined. */
const useShared = (workspaceId: string): SidebarDataContextType | undefined => {
  const shared = useContext(SidebarDataContext);
  return shared !== undefined && shared.workspaceId === workspaceId
    ? shared
    : undefined;
};

/** Returns the triage count of every team with triage on in the workspace. */
export const useTriageSummary = (
  workspaceId: string
): TriageSummaryRead | null => {
  const shared = useShared(workspaceId);
  const auth = useQueryAuth();
  const own = usePolledQuery(
    ({ signal }) => getTriageSummary(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: shared === undefined && workspaceId !== '',
      queryKey: triageSummaryKey(workspaceId),
      auth,
    }
  );
  return shared === undefined ? own.data : shared.triage;
};

/** Returns the caller's own saved views in the workspace. */
export const useOwnViews = (
  workspaceId: string
): SavedViewDisplayRead[] | null => {
  const shared = useShared(workspaceId);
  const auth = useQueryAuth();
  const own = usePolledQuery(
    ({ signal }) => listViews(workspaceId, { scope: 'mine' }, signal),
    {
      intervalMs: POLL_MS,
      enabled: shared === undefined && workspaceId !== '',
      queryKey: viewsKey(workspaceId, 'mine', ''),
      auth,
    }
  );
  return shared === undefined ? own.data : shared.views;
};

/** Returns the caller's unread inbox count in the workspace. */
export const useInboxCount = (workspaceId: string): number | null => {
  const shared = useShared(workspaceId);
  const auth = useQueryAuth();
  const own = usePolledQuery(
    ({ signal }) => getInboxCount(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: shared === undefined && workspaceId !== '',
      queryKey: inboxCountKey(workspaceId),
      auth,
    }
  );
  return shared === undefined ? own.data : shared.inboxCount;
};
