/**
 * One issue's history, newest first and paged on request. The entries carry ids
 * rather than names, so each line says what changed and leaves the value to the
 * fields above, which are the ones that hold the lists to resolve against.
 */

import React, { useCallback } from 'react';
import { appendActivity, listActivity } from '../../api/issues';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { errorMessage } from '../../lib/errors';
import { activitySentence, timestampLabel } from '../../lib/issueDisplay';
import { actorLabel, type Assignable } from '../../lib/issuePeople';
import { activityKey } from '../../lib/queryKeys';
import type { ActivityRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Spinner from '../ui/spinner';

/** Props for ActivityFeed: which issue, and who its entries may name. */
export interface ActivityFeedProps {
  workspaceId: string;
  issueId: string;
  people: Assignable[];
}

/** How many entries one page asks for. */
const PAGE_SIZE = 50;

/** How often the newest page is re-read while the issue is open. */
const POLL_MS = 60000;

/** Reads and pages one issue's activity. */
export const ActivityFeed: React.FC<ActivityFeedProps> = ({
  workspaceId,
  issueId,
  people,
}) => {
  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<ActivityRead>> => {
      const page = await listActivity(
        workspaceId,
        issueId,
        { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      );
      return { rows: page.activity, nextCursor: page.next_cursor };
    },
    [workspaceId, issueId]
  );

  const merge = useCallback(
    (held: ActivityRead[], incoming: ActivityRead[]): ActivityRead[] =>
      appendActivity(held, { activity: incoming, next_cursor: null }),
    []
  );

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, merge, {
      queryKey: activityKey(issueId),
      enabled: workspaceId !== '' && issueId !== '',
      intervalMs: POLL_MS,
    });

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-white">Activity</h3>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the activity.')}
        />
      )}

      {isLoading ? (
        <Spinner label="Loading activity" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing has happened yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((entry) => (
            <li
              key={entry.activity_id}
              className="flex flex-wrap items-baseline gap-2 text-sm text-slate-300"
            >
              <span className="text-slate-100">
                {actorLabel(entry.actor_kind, entry.actor_id, people)}
              </span>
              <span>{activitySentence(entry)}</span>
              <span className="text-xs text-slate-500">
                {timestampLabel(entry.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {hasMore && !isLoading && (
        <Button variant="secondary" disabled={isPaging} onClick={loadMore}>
          {isPaging ? 'Loading' : 'Load more'}
        </Button>
      )}
    </section>
  );
};

export default ActivityFeed;
