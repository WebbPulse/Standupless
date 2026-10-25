/**
 * Reads what the workspace sidebar shows beyond the team list once, above the
 * pages. Every page mounts its own sidebar, so a read held inside it started
 * again from nothing on each navigation and the triage entries, the view list,
 * the inbox badge, the reviews badge, the Pulse badge and the favorites blinked out until it settled.
 *
 * It also holds the workspace change socket, since it is mounted exactly as
 * long as a workspace is open, and stretches the triage and inbox polls while
 * that socket's notices keep them current.
 *
 * Which teams have triage on is published again on its own, so the status
 * cell of every list row reads it without rendering for each badge re-read.
 */

import React, { useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getPulseCount } from '../api/pulse';
import { getReviews } from '../api/reviews';
import { getTriageSummary } from '../api/triage';
import { getInboxCount, listViews } from '../api/views';
import { useFavoritesState } from '../hooks/useFavorites';
import { useWorkspace } from '../hooks/useWorkspace';
import { useRealtimePollMs } from '../lib/polling';
import { useRealtime } from '../lib/realtime';
import {
  inboxCountKey,
  pulseCountKey,
  reviewsKey,
  triageSummaryKey,
  viewsKey,
} from '../lib/queryKeys';
import {
  SidebarDataContext,
  type SidebarDataContextType,
} from './SidebarDataContextDefinition';
import TriageTeamsProvider from './TriageTeamsProvider';

/** How often the sidebar's reads are repeated while a workspace page is open. */
export const SIDEBAR_POLL_MS = 60000;

/** Supplies the sidebar's reads for the current workspace. */
export const SidebarDataProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const workspaceId = workspace?.id ?? '';
  const enabled = workspaceId !== '';
  useRealtime(workspaceId);
  const noticedPollMs = useRealtimePollMs(SIDEBAR_POLL_MS);

  const { data: triage } = usePolledQuery(
    ({ signal }) => getTriageSummary(workspaceId, signal),
    {
      intervalMs: noticedPollMs,
      enabled,
      queryKey: triageSummaryKey(workspaceId),
      auth,
    }
  );

  const { data: views } = usePolledQuery(
    ({ signal }) => listViews(workspaceId, { scope: 'all' }, signal),
    {
      intervalMs: SIDEBAR_POLL_MS,
      enabled,
      queryKey: viewsKey(workspaceId, 'all', ''),
      auth,
    }
  );

  const { data: inboxCount } = usePolledQuery(
    ({ signal }) => getInboxCount(workspaceId, signal),
    {
      intervalMs: noticedPollMs,
      enabled,
      queryKey: inboxCountKey(workspaceId),
      auth,
    }
  );

  const { data: reviews } = usePolledQuery(
    ({ signal }) => getReviews(workspaceId, signal),
    {
      intervalMs: SIDEBAR_POLL_MS,
      enabled,
      queryKey: reviewsKey(workspaceId),
      auth,
    }
  );

  const { data: pulseCount } = usePolledQuery(
    ({ signal }) => getPulseCount(workspaceId, signal),
    {
      intervalMs: SIDEBAR_POLL_MS,
      enabled,
      queryKey: pulseCountKey(workspaceId),
      auth,
    }
  );

  const favorites = useFavoritesState(workspaceId, enabled);

  const value = useMemo<SidebarDataContextType>(
    () => ({
      workspaceId,
      triage,
      views,
      inboxCount,
      reviews,
      pulseCount,
      favorites,
    }),
    [workspaceId, triage, views, inboxCount, reviews, pulseCount, favorites]
  );

  return (
    <SidebarDataContext.Provider value={value}>
      <TriageTeamsProvider triage={triage}>{children}</TriageTeamsProvider>
    </SidebarDataContext.Provider>
  );
};

export default SidebarDataProvider;
