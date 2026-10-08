/**
 * Every initiative in the workspace, read to the end of the cursor. A
 * workspace holds a handful of initiatives, so the list page groups and counts
 * the whole set at once rather than paging on request.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import { listInitiatives } from '../api/initiatives';
import { initiativesKey } from '../lib/queryKeys';
import type { InitiativeRead } from '../types/Api';

/** How often the initiatives re-read. */
const POLL_MS = 60000;

/** What {@link useInitiatives} hands back. */
export interface WorkspaceInitiatives {
  initiatives: InitiativeRead[];
  error: unknown;
  isLoading: boolean;
  /** The key the read runs under, for a write to invalidate. */
  queryKey: QueryKey;
}

/** Reads every initiative, stopping on a repeated cursor rather than looping. */
export const listAllInitiatives = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<InitiativeRead[]> => {
  const initiatives: InitiativeRead[] = [];
  let cursor: string | null = null;
  do {
    const page = await listInitiatives(
      workspaceId,
      cursor === null ? {} : { cursor },
      signal
    );
    initiatives.push(...page.initiatives);
    if (page.next_cursor !== null && page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  } while (cursor !== null);
  return initiatives;
};

/** Reads the workspace's initiatives. */
export const useInitiatives = (
  workspaceId: string,
  enabled = true
): WorkspaceInitiatives => {
  const auth = useQueryAuth();
  const queryKey = initiativesKey(workspaceId, '');

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listAllInitiatives(workspaceId, signal),
    [workspaceId]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '',
    queryKey,
    auth,
  });

  return { initiatives: data ?? [], error, isLoading, queryKey };
};

export default useInitiatives;
