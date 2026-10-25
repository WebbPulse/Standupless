/**
 * The workspace's project statuses. A workspace keeps few enough to fit one
 * read, so pickers, glyphs, columns and filters look statuses up in memory.
 * Outside a workspace, and until the list arrives, the six seeded defaults
 * stand in, so a project always resolves to a status.
 */

import { useCallback, useContext, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import { listProjectStatuses } from '../api/projectStatuses';
import { WorkspaceContext } from '../contexts/WorkspaceContextDefinition';
import {
  DEFAULT_PROJECT_STATUSES,
  projectStatusOf,
  type HasProjectStatus,
} from '../lib/projectStatuses';
import { projectStatusesKey } from '../lib/queryKeys';
import type { ProjectStatusRead } from '../types/Api';

/** How often the project statuses re-read. */
const POLL_MS = 60000;

/** What {@link useProjectStatuses} hands back. */
export interface WorkspaceProjectStatuses {
  statuses: ProjectStatusRead[];
  /** Each status by id, for rows that hold only an id. */
  byId: Map<string, ProjectStatusRead>;
  /** The status a project sits in. */
  statusOf: (project: HasProjectStatus) => ProjectStatusRead;
  error: unknown;
  isLoading: boolean;
  /** The key the read runs under, for a write to invalidate. */
  queryKey: QueryKey;
}

/** Reads the project statuses of the given workspace, or of the current one. */
export const useProjectStatuses = (
  workspaceId?: string
): WorkspaceProjectStatuses => {
  const auth = useQueryAuth();
  const context = useContext(WorkspaceContext);
  const id = workspaceId ?? context?.workspace?.id ?? '';
  const queryKey = projectStatusesKey(id);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) => listProjectStatuses(id, signal),
    [id]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: id !== '',
    queryKey,
    auth,
  });

  const statuses = useMemo(
    () =>
      data !== null && data !== undefined && data.length > 0
        ? data
        : DEFAULT_PROJECT_STATUSES,
    [data]
  );
  const byId = useMemo(
    () => new Map(statuses.map((row) => [row.id, row])),
    [statuses]
  );
  const statusOf = useCallback(
    (project: HasProjectStatus) => projectStatusOf(project, statuses),
    [statuses]
  );

  return { statuses, byId, statusOf, error, isLoading, queryKey };
};

export default useProjectStatuses;
