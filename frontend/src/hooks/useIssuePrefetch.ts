/**
 * Warms an issue's detail read while the pointer or focus rests on a row or
 * card that links to it, so opening the issue paints from the shared query
 * cache instead of waiting on the network.
 */

import { useCallback, useContext, useEffect, useRef } from 'react';
import { prefetchPolledQuery } from '@webbpulse/api-client/react';
import { getIssueByKey } from '../api/issues';
import { WorkspaceContext } from '../contexts/WorkspaceContextDefinition';
import { issueKey } from '../lib/queryKeys';

/** How long the pointer or focus has to rest before the read starts. */
export const ISSUE_PREFETCH_DELAY_MS = 100;

/** How old a cached issue may be before a rest reads it again. */
export const ISSUE_PREFETCH_STALE_MS = 30000;

/** The handlers a row or card link spreads to prefetch its issue. */
export interface IssuePrefetchHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * Starts the issue page's own read of `key`, under the same query key and
 * fetcher, once the pointer or focus has rested for
 * {@link ISSUE_PREFETCH_DELAY_MS}. Leaving before then cancels it, so a sweep
 * across a list reads nothing. `focused` covers keyboard focus a list tracks
 * itself, such as j and k moving between rows. Outside a workspace it does
 * nothing.
 */
export const useIssuePrefetch = (
  key: string,
  focused = false
): IssuePrefetchHandlers => {
  const workspaceId = useContext(WorkspaceContext)?.workspace?.id ?? '';
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancel = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const schedule = useCallback(() => {
    if (workspaceId === '' || key === '' || timer.current !== undefined) {
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void prefetchPolledQuery(
        issueKey(workspaceId, key),
        (context) => getIssueByKey(workspaceId, key, context),
        { staleTimeMs: ISSUE_PREFETCH_STALE_MS }
      );
    }, ISSUE_PREFETCH_DELAY_MS);
  }, [workspaceId, key]);

  useEffect(() => {
    if (!focused) return undefined;
    schedule();
    return cancel;
  }, [focused, schedule, cancel]);

  useEffect(() => cancel, [cancel]);

  return {
    onMouseEnter: schedule,
    onMouseLeave: cancel,
    onFocus: schedule,
    onBlur: cancel,
  };
};
