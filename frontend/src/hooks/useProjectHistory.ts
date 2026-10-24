/**
 * One project's recorded progress history and projected finish. It polls like
 * the project's other panels, and its key sits under the project's own, so a
 * project write refreshes the graph too.
 */

import { useCallback } from 'react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getProjectHistory } from '../api/planning';
import { projectHistoryKey } from '../lib/queryKeys';
import type { ProjectHistoryRead } from '../types/Api';

/** How often the history re-reads. */
const POLL_MS = 60000;

/** Reads one project's progress history, `null` until it has loaded. */
export const useProjectHistory = (
  workspaceId: string,
  projectId: string,
  enabled = true
): ProjectHistoryRead | null => {
  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getProjectHistory(workspaceId, projectId, signal),
    [workspaceId, projectId]
  );
  const { data } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '' && projectId !== '',
    queryKey: projectHistoryKey(workspaceId, projectId),
  });
  return data ?? null;
};

export default useProjectHistory;
