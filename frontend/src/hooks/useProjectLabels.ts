/**
 * The workspace's project labels. A workspace keeps few enough to fit one
 * read, so pickers, chips and filters look labels up in memory.
 */

import { useCallback, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import { listProjectLabels } from '../api/projectLabels';
import { projectLabelsKey } from '../lib/queryKeys';
import type { ProjectLabelRead } from '../types/Api';

/** How often the project labels re-read. */
const POLL_MS = 60000;

/** What {@link useProjectLabels} hands back. */
export interface WorkspaceProjectLabels {
  labels: ProjectLabelRead[];
  /** Each label by id, for chips that hold only ids. */
  byId: Map<string, ProjectLabelRead>;
  error: unknown;
  isLoading: boolean;
  /** The key the read runs under, for a write to invalidate. */
  queryKey: QueryKey;
}

/** Reads the workspace's project labels. */
export const useProjectLabels = (
  workspaceId: string,
  enabled = true
): WorkspaceProjectLabels => {
  const auth = useQueryAuth();
  const queryKey = projectLabelsKey(workspaceId);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listProjectLabels(workspaceId, signal),
    [workspaceId]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '',
    queryKey,
    auth,
  });

  const labels = useMemo(() => data ?? [], [data]);
  const byId = useMemo(
    () => new Map(labels.map((label) => [label.id, label])),
    [labels]
  );

  return { labels, byId, error, isLoading, queryKey };
};

export default useProjectLabels;
