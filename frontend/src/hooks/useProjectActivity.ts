/**
 * One project's activity, newest first, a cursor page at a time. The first page
 * polls like the updates do, and later pages are appended on request. The key
 * sits under the project's own, so a project write refreshes it too.
 */

import { useCallback } from 'react';
import { listProjectActivity } from '../api/planning';
import { projectActivityKey } from '../lib/queryKeys';
import type { ProjectActivityRead } from '../types/Api';
import { useCursorPages } from './useCursorPages';

/** How often the first page re-reads. */
const POLL_MS = 30000;

/** How many activity rows a page holds. */
export const PROJECT_ACTIVITY_PAGE_SIZE = 20;

/** What {@link useProjectActivity} hands back. */
export interface ProjectActivity {
  /** Every row loaded so far, newest first. */
  activity: ProjectActivityRead[];
  isLoading: boolean;
  error: unknown;
  isPaging: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

/** Appends a page, dropping a row the held rows already carry. */
export const appendActivity = (
  held: ProjectActivityRead[],
  incoming: ProjectActivityRead[]
): ProjectActivityRead[] => {
  const seen = new Set(held.map((row) => row.activity_id));
  return [...held, ...incoming.filter((row) => !seen.has(row.activity_id))];
};

/** Reads one project's activity feed. */
export const useProjectActivity = (
  workspaceId: string,
  projectId: string,
  enabled = true
): ProjectActivity => {
  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listProjectActivity(
        workspaceId,
        projectId,
        {
          limit: PROJECT_ACTIVITY_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal
      ).then((page) => ({ rows: page.activity, nextCursor: page.next_cursor })),
    [workspaceId, projectId]
  );

  const pages = useCursorPages(read, appendActivity, {
    queryKey: projectActivityKey(workspaceId, projectId),
    enabled: enabled && workspaceId !== '' && projectId !== '',
    intervalMs: POLL_MS,
  });

  return {
    activity: pages.rows,
    isLoading: pages.isLoading,
    error: pages.error,
    isPaging: pages.isPaging,
    hasMore: pages.hasMore,
    loadMore: pages.loadMore,
  };
};

export default useProjectActivity;
