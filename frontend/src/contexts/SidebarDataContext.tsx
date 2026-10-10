/**
 * Reads what the workspace sidebar shows beyond the team list once, above the
 * pages. Every page mounts its own sidebar, so a read held inside it started
 * again from nothing on each navigation and the triage entries, the view list
 * and the inbox badge blinked out until it settled.
 */

import React, { useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getTriageSummary } from '../api/triage';
import { getInboxCount, listViews } from '../api/views';
import { useWorkspace } from '../hooks/useWorkspace';
import { inboxCountKey, triageSummaryKey, viewsKey } from '../lib/queryKeys';
import {
  SidebarDataContext,
  type SidebarDataContextType,
} from './SidebarDataContextDefinition';

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

  const { data: triage } = usePolledQuery(
    ({ signal }) => getTriageSummary(workspaceId, signal),
    {
      intervalMs: SIDEBAR_POLL_MS,
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
      intervalMs: SIDEBAR_POLL_MS,
      enabled,
      queryKey: inboxCountKey(workspaceId),
      auth,
    }
  );

  const value = useMemo<SidebarDataContextType>(
    () => ({ workspaceId, triage, views, inboxCount }),
    [workspaceId, triage, views, inboxCount]
  );

  return (
    <SidebarDataContext.Provider value={value}>
      {children}
    </SidebarDataContext.Provider>
  );
};

export default SidebarDataProvider;
