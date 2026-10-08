/**
 * One project's updates, newest first, a cursor page at a time. The first page
 * polls like every other list, and later pages are appended on request.
 *
 * Every write re-reads the project as well as the updates, because posting,
 * editing the newest update or deleting it moves the project's health and its
 * last update time on the server, and the page shows both.
 */

import { useCallback } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  createProjectUpdate,
  deleteProjectUpdate,
  listProjectUpdates,
  updateProjectUpdate,
} from '../api/planning';
import {
  projectDetailKey,
  projectsKey,
  projectUpdatesKey,
} from '../lib/queryKeys';
import type {
  ProjectUpdateCreate,
  ProjectUpdateEdit,
  ProjectUpdateRead,
  StatusUpdateRead,
} from '../types/Api';
import { useCursorPages } from './useCursorPages';

/** How often the first page re-reads. */
const POLL_MS = 30000;

/** How many updates a page holds. */
export const PROJECT_UPDATES_PAGE_SIZE = 20;

/** A feed of status updates on a project or an initiative. */
export interface StatusUpdateFeed<
  T extends StatusUpdateRead = StatusUpdateRead,
> {
  /** Every update loaded so far, newest first. */
  updates: T[];
  /** The newest update, or null when there is none or it has not loaded. */
  latest: T | null;
  isLoading: boolean;
  error: unknown;
  isPaging: boolean;
  hasMore: boolean;
  loadMore: () => void;
  /** Posts an update. Rejects when the write failed. */
  create: (body: ProjectUpdateCreate) => Promise<T>;
  /** Edits an update. Rejects when the write failed. */
  edit: (updateId: string, body: ProjectUpdateEdit) => Promise<T>;
  /** Deletes an update. Rejects when the write failed. */
  remove: (updateId: string) => Promise<void>;
}

/** What {@link useProjectUpdates} hands back. */
export type ProjectUpdates = StatusUpdateFeed<ProjectUpdateRead>;

/** Appends a page, dropping an update the held rows already carry. */
export const appendUpdates = <T extends StatusUpdateRead>(
  held: T[],
  incoming: T[]
): T[] => {
  const seen = new Set(held.map((row) => row.update_id));
  return [...held, ...incoming.filter((row) => !seen.has(row.update_id))];
};

/** Reads and writes one project's updates. */
export const useProjectUpdates = (
  workspaceId: string,
  projectId: string,
  enabled = true
): ProjectUpdates => {
  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listProjectUpdates(
        workspaceId,
        projectId,
        {
          limit: PROJECT_UPDATES_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal
      ).then((page) => ({ rows: page.updates, nextCursor: page.next_cursor })),
    [workspaceId, projectId]
  );

  const pages = useCursorPages(read, appendUpdates, {
    queryKey: projectUpdatesKey(workspaceId, projectId),
    enabled: enabled && workspaceId !== '' && projectId !== '',
    intervalMs: POLL_MS,
  });

  const refresh = useCallback((): void => {
    invalidateQueries([
      projectUpdatesKey(workspaceId, projectId),
      projectDetailKey(workspaceId, projectId),
      projectsKey(workspaceId, '', ''),
    ]);
  }, [workspaceId, projectId]);

  const create = useCallback(
    async (body: ProjectUpdateCreate): Promise<ProjectUpdateRead> => {
      const made = await createProjectUpdate(workspaceId, projectId, body);
      refresh();
      return made;
    },
    [workspaceId, projectId, refresh]
  );

  const edit = useCallback(
    async (
      updateId: string,
      body: ProjectUpdateEdit
    ): Promise<ProjectUpdateRead> => {
      const saved = await updateProjectUpdate(
        workspaceId,
        projectId,
        updateId,
        body
      );
      refresh();
      return saved;
    },
    [workspaceId, projectId, refresh]
  );

  const remove = useCallback(
    async (updateId: string): Promise<void> => {
      await deleteProjectUpdate(workspaceId, projectId, updateId);
      refresh();
    },
    [workspaceId, projectId, refresh]
  );

  return {
    updates: pages.rows,
    latest: pages.rows[0] ?? null,
    isLoading: pages.isLoading,
    error: pages.error,
    isPaging: pages.isPaging,
    hasMore: pages.hasMore,
    loadMore: pages.loadMore,
    create,
    edit,
    remove,
  };
};

export default useProjectUpdates;
