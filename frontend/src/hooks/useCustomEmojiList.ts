/**
 * The workspace's custom emoji as the settings page lists them, and the one
 * read the workspace layout publishes for every picker and renderer. A
 * workspace keeps few enough to fit one read.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import { listCustomEmoji } from '../api/customEmoji';
import { publishCustomEmoji } from '../lib/customEmoji';
import { customEmojiKey } from '../lib/queryKeys';
import type { CustomEmojiRead } from '../types/Api';

/** How often the custom emoji re-read. */
const POLL_MS = 120000;

/** What {@link useCustomEmojiList} hands back. */
export interface WorkspaceCustomEmoji {
  emoji: CustomEmojiRead[];
  error: unknown;
  isLoading: boolean;
  /** The key the read runs under, for a write to invalidate. */
  queryKey: QueryKey;
}

/** Reads the workspace's custom emoji. */
export const useCustomEmojiList = (
  workspaceId: string,
  enabled = true
): WorkspaceCustomEmoji => {
  const auth = useQueryAuth();
  const queryKey = customEmojiKey(workspaceId);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listCustomEmoji(workspaceId, signal),
    [workspaceId]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '',
    queryKey,
    auth,
  });

  const emoji = useMemo(() => data ?? [], [data]);
  return { emoji, error, isLoading, queryKey };
};

/**
 * Publishes the workspace's custom emoji for every surface outside the
 * settings page, and clears them when the workspace closes.
 */
export const usePublishCustomEmoji = (workspaceId: string): void => {
  const { emoji } = useCustomEmojiList(workspaceId);
  useEffect(() => {
    publishCustomEmoji(emoji);
  }, [emoji]);
  useEffect(
    () => () => {
      publishCustomEmoji([]);
    },
    [workspaceId]
  );
};

export default useCustomEmojiList;
