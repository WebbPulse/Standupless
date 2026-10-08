/**
 * One initiative's updates, newest first, a cursor page at a time, on the same
 * cadence and paging as a project's. Every write re-reads the initiative too,
 * because posting or removing the newest update moves its health.
 */

import { useCallback } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  createInitiativeUpdate,
  deleteInitiativeUpdate,
  listInitiativeUpdates,
  updateInitiativeUpdate,
} from '../api/initiatives';
import {
  initiativeDetailKey,
  initiativeUpdatesKey,
  initiativesKey,
} from '../lib/queryKeys';
import type {
  InitiativeUpdateRead,
  ProjectUpdateCreate,
  ProjectUpdateEdit,
} from '../types/Api';
import { useCursorPages } from './useCursorPages';
import {
  PROJECT_UPDATES_PAGE_SIZE,
  appendUpdates,
  type StatusUpdateFeed,
} from './useProjectUpdates';

/** How often the first page re-reads. */
const POLL_MS = 30000;

/** Reads and writes one initiative's updates. */
export const useInitiativeUpdates = (
  workspaceId: string,
  initiativeId: string,
  enabled = true
): StatusUpdateFeed<InitiativeUpdateRead> => {
  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listInitiativeUpdates(
        workspaceId,
        initiativeId,
        {
          limit: PROJECT_UPDATES_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal
      ).then((page) => ({ rows: page.updates, nextCursor: page.next_cursor })),
    [workspaceId, initiativeId]
  );

  const pages = useCursorPages(read, appendUpdates, {
    queryKey: initiativeUpdatesKey(workspaceId, initiativeId),
    enabled: enabled && workspaceId !== '' && initiativeId !== '',
    intervalMs: POLL_MS,
  });

  const refresh = useCallback((): void => {
    invalidateQueries([
      initiativeUpdatesKey(workspaceId, initiativeId),
      initiativeDetailKey(workspaceId, initiativeId),
      initiativesKey(workspaceId, ''),
    ]);
  }, [workspaceId, initiativeId]);

  const create = useCallback(
    async (body: ProjectUpdateCreate): Promise<InitiativeUpdateRead> => {
      const made = await createInitiativeUpdate(
        workspaceId,
        initiativeId,
        body
      );
      refresh();
      return made;
    },
    [workspaceId, initiativeId, refresh]
  );

  const edit = useCallback(
    async (
      updateId: string,
      body: ProjectUpdateEdit
    ): Promise<InitiativeUpdateRead> => {
      const saved = await updateInitiativeUpdate(
        workspaceId,
        initiativeId,
        updateId,
        body
      );
      refresh();
      return saved;
    },
    [workspaceId, initiativeId, refresh]
  );

  const remove = useCallback(
    async (updateId: string): Promise<void> => {
      await deleteInitiativeUpdate(workspaceId, initiativeId, updateId);
      refresh();
    },
    [workspaceId, initiativeId, refresh]
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

export default useInitiativeUpdates;
