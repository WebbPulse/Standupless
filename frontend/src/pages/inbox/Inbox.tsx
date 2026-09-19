/**
 * The caller's notifications. There is no recipient parameter anywhere on this
 * page: the partition is built from the session, so a person can only ever read
 * their own rows and the page never has to decide whose inbox it is showing.
 */

import React, { useCallback, useState } from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import {
  appendNotifications,
  deleteNotification,
  listInbox,
  markAllRead,
  markRead,
} from '../../api/views';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useWorkspace } from '../../hooks/useWorkspace';
import { m3ErrorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { inboxCountKey, inboxKey } from '../../lib/queryKeys';
import type { NotificationKind, NotificationRead } from '../../types/Api';

/** How often the inbox re-reads, matching the badge so the two agree. */
const POLL_MS = 60000;

/** How many rows a page holds. */
const PAGE_SIZE = 50;

/** How each kind of notification reads in the interface. */
const KIND_LABELS: Record<NotificationKind, string> = {
  assigned: 'Assigned to you',
  mentioned: 'Mentioned you',
  commented: 'New comment',
  status_changed: 'Status changed',
};

/** Names a notification's kind, falling back for one added after this build. */
const kindLabel = (kind: NotificationKind): string =>
  KIND_LABELS[kind] ?? 'Update';

/** Lists the caller's notifications and marks them read. */
export const Inbox: React.FC = () => {
  const { workspace } = useWorkspace();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const enabled = workspaceId !== '';
  const queryKey = inboxKey(workspaceId, unreadOnly);

  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listInbox(
        workspaceId,
        {
          ...(unreadOnly ? { unread: true } : {}),
          ...(cursor === undefined ? {} : { cursor }),
          limit: PAGE_SIZE,
        },
        signal
      ).then((page) => ({
        rows: page.notifications,
        nextCursor: page.next_cursor,
      })),
    [workspaceId, unreadOnly]
  );

  const merge = useCallback(
    (held: NotificationRead[], incoming: NotificationRead[]) =>
      appendNotifications(held, incoming),
    []
  );

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, merge, { queryKey, enabled, intervalMs: POLL_MS });

  const refetchKeys = [queryKey, inboxCountKey(workspaceId)];

  const { mutate: readOne, error: readError } = useMutationWithRefetch(
    (notificationId: string) =>
      markRead(workspaceId, { notification_ids: [notificationId] }),
    refetchKeys
  );

  const {
    mutate: readAll,
    isMutating: isReadingAll,
    error: readAllError,
  } = useMutationWithRefetch(() => markAllRead(workspaceId), refetchKeys);

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (notificationId: string) => deleteNotification(workspaceId, notificationId),
    refetchKeys
  );

  return (
    <WorkspaceShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-white">Inbox</h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(event) => {
                  setUnreadOnly(event.target.checked);
                }}
              />
              Unread only
            </label>
            <Button
              variant="secondary"
              disabled={isReadingAll || rows.length === 0}
              onClick={() => {
                void readAll().catch(() => undefined);
              }}
            >
              {isReadingAll ? 'Marking' : 'Mark all read'}
            </Button>
          </div>
        </div>

        {error !== null && (
          <ErrorAlert
            message={m3ErrorMessage(error, 'Could not load your inbox.')}
          />
        )}
        {readError !== null && (
          <ErrorAlert
            message={m3ErrorMessage(readError, 'Could not mark that read.')}
          />
        )}
        {readAllError !== null && (
          <ErrorAlert
            message={m3ErrorMessage(
              readAllError,
              'Could not mark everything read.'
            )}
          />
        )}
        {removeError !== null && (
          <ErrorAlert
            message={m3ErrorMessage(removeError, 'Could not remove that row.')}
          />
        )}

        {isLoading ? (
          <Spinner label="Loading inbox" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">
            {unreadOnly ? 'Nothing unread.' : 'Nothing here yet.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.notification_id}
                className={`flex flex-wrap items-start gap-2 rounded-md border p-3 ${
                  row.unread
                    ? 'border-sky-700 bg-sky-500/5'
                    : 'border-slate-700'
                }`}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    {kindLabel(row.kind)}
                  </p>
                  <Link
                    to={`/w/${slug}/issues/${row.issue_key}`}
                    className="block text-sm text-slate-100 hover:text-white"
                    onClick={() => {
                      if (row.unread) {
                        void readOne(row.notification_id).catch(
                          () => undefined
                        );
                      }
                    }}
                  >
                    <span className="font-mono text-xs text-sky-400">
                      {row.issue_key}
                    </span>{' '}
                    {row.issue_title}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {timestampLabel(row.created_at)}
                  </p>
                </div>

                {row.unread && (
                  <Button
                    variant="secondary"
                    aria-label={`Mark ${row.issue_key} read`}
                    onClick={() => {
                      void readOne(row.notification_id).catch(() => undefined);
                    }}
                  >
                    Mark read
                  </Button>
                )}
                <Button
                  variant="secondary"
                  aria-label={`Remove ${row.issue_key}`}
                  onClick={() => {
                    void remove(row.notification_id).catch(() => undefined);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        {hasMore && (
          <Button variant="secondary" disabled={isPaging} onClick={loadMore}>
            {isPaging ? 'Loading' : 'Load more'}
          </Button>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Inbox;
