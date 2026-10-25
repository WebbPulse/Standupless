/**
 * One member's profile and recent activity for the member page. Either hook
 * accepts `me` for the caller, so the caller's own page and any later "my
 * activity" surface share the read.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getMemberProfile, listMemberActivity } from '../api/members';
import { memberActivityKey, memberProfileKey } from '../lib/queryKeys';
import type { MemberActivityRead, MemberProfileRead } from '../types/Api';
import { useCursorPages } from './useCursorPages';

/** How often the profile and the first activity page re-read. */
const POLL_MS = 30000;

/** How many activity rows a page holds. */
export const MEMBER_ACTIVITY_PAGE_SIZE = 20;

/** What {@link useMemberProfile} hands back. */
export interface MemberProfileState {
  profile: MemberProfileRead | null;
  isLoading: boolean;
  error: unknown;
}

/** Reads one member's profile. */
export const useMemberProfile = (
  workspaceId: string,
  userId: string
): MemberProfileState => {
  const auth = useQueryAuth();
  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getMemberProfile(workspaceId, userId, signal),
    [workspaceId, userId]
  );
  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: workspaceId !== '' && userId !== '',
    queryKey: memberProfileKey(workspaceId, userId),
    auth,
  });
  return { profile: data ?? null, isLoading, error };
};

/** What {@link useMemberActivity} hands back. */
export interface MemberActivity {
  /** Every row loaded so far, newest first. */
  activity: MemberActivityRead[];
  isLoading: boolean;
  error: unknown;
  isPaging: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

/** Appends a page, dropping a row the held rows already carry. */
export const appendMemberActivity = (
  held: MemberActivityRead[],
  incoming: MemberActivityRead[]
): MemberActivityRead[] => {
  const seen = new Set(held.map((row) => row.id));
  return [...held, ...incoming.filter((row) => !seen.has(row.id))];
};

/** Reads one member's activity feed, a cursor page at a time. */
export const useMemberActivity = (
  workspaceId: string,
  userId: string,
  enabled = true
): MemberActivity => {
  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listMemberActivity(
        workspaceId,
        userId,
        {
          limit: MEMBER_ACTIVITY_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal
      ).then((page) => ({
        rows: page.activity,
        nextCursor: page.next_cursor ?? null,
      })),
    [workspaceId, userId]
  );

  const pages = useCursorPages(read, appendMemberActivity, {
    queryKey: memberActivityKey(workspaceId, userId),
    enabled: enabled && workspaceId !== '' && userId !== '',
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

export default useMemberActivity;
