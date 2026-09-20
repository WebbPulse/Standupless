/**
 * The caller's notifications. There is no recipient parameter anywhere on this
 * page: the partition is built from the session, so a person can only ever read
 * their own rows and the page never has to decide whose inbox it is showing.
 */

import React, { useCallback, useState } from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import { LuCheck, LuCheckCheck, LuInbox, LuX } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import {
  appendNotifications,
  deleteNotification,
  listInbox,
  markAllRead,
  markRead,
} from '../../api/views';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import Checkbox from '../../components/ui/checkbox';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/cn';
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
    <WorkspaceShell
      title="Inbox"
      actions={
        <>
          <Checkbox
            label="Unread only"
            className="mr-2 text-text-muted"
            checked={unreadOnly}
            onChange={(event) => {
              setUnreadOnly(event.target.checked);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={isReadingAll || rows.length === 0}
            onClick={() => {
              void readAll().catch(() => undefined);
            }}
          >
            <LuCheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {isReadingAll ? 'Marking' : 'Mark all read'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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
          <EmptyState
            icon={<LuInbox />}
            message={unreadOnly ? 'Nothing unread.' : 'Nothing here yet.'}
          />
        ) : (
          <ul className="rounded-md border border-line">
            {rows.map((row) => (
              <li
                key={row.notification_id}
                className="flex h-row items-center gap-3 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    row.unread ? 'bg-accent' : 'bg-transparent'
                  )}
                />
                <span className="hidden w-28 shrink-0 truncate text-xs text-text-muted sm:block">
                  {kindLabel(row.kind)}
                </span>
                <Link
                  to={`/w/${slug}/issues/${row.issue_key}`}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-xs text-sm text-text"
                  onClick={() => {
                    if (row.unread) {
                      void readOne(row.notification_id).catch(() => undefined);
                    }
                  }}
                >
                  <span className="shrink-0 font-mono text-xs text-text-faint">
                    {row.issue_key}
                  </span>
                  <span
                    className={cn('truncate', row.unread ? 'font-medium' : '')}
                  >
                    {row.issue_title}
                  </span>
                </Link>
                <span className="hidden shrink-0 text-xs text-text-muted tabular-nums md:block">
                  {timestampLabel(row.created_at)}
                </span>
                {row.unread && (
                  <IconButton
                    label={`Mark ${row.issue_key} read`}
                    size="sm"
                    onClick={() => {
                      void readOne(row.notification_id).catch(() => undefined);
                    }}
                  >
                    <LuCheck className="h-3.5 w-3.5" />
                  </IconButton>
                )}
                <IconButton
                  label={`Remove ${row.issue_key}`}
                  size="sm"
                  onClick={() => {
                    void remove(row.notification_id).catch(() => undefined);
                  }}
                >
                  <LuX className="h-3.5 w-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}

        {hasMore && (
          <Button
            variant="secondary"
            size="sm"
            disabled={isPaging}
            onClick={loadMore}
          >
            {isPaging ? 'Loading' : 'Load more'}
          </Button>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Inbox;
