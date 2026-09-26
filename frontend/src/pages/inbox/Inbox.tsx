/**
 * The caller's notifications as a split pane: the list on the left and the
 * selected notification's issue on the right, so triage runs down the list
 * without leaving it. There is no recipient parameter anywhere on this page:
 * the partition is built from the session, so a person can only ever read
 * their own rows and the page never has to decide whose inbox it is showing.
 * The selection lives in the URL, so a link lands on the same row.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import { LuCheck, LuCheckCheck, LuInbox, LuX } from 'react-icons/lu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  appendNotifications,
  deleteNotification,
  listInbox,
  markAllRead,
  markRead,
} from '../../api/views';
import IssuePeek from '../../components/issues/IssuePeek';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import Checkbox from '../../components/ui/checkbox';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useShortcut } from '../../hooks/useShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/cn';
import { m3ErrorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { issuePath } from '../../lib/paths';
import { inboxCountKey, inboxKey } from '../../lib/queryKeys';
import type { NotificationKind, NotificationRead } from '../../types/Api';

/** How often the inbox re-reads, matching the badge so the two agree. */
const POLL_MS = 60000;

/** How many rows a page holds. */
const PAGE_SIZE = 50;

/** The URL parameter holding the selected notification. */
const SELECTED_PARAM = 'n';

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

/** Props for InboxRow. */
interface InboxRowProps {
  row: NotificationRead;
  selected: boolean;
  onSelect: () => void;
  onRead: () => void;
  onRemove: () => void;
}

/** One notification: who did what to which issue, and its row actions. */
const InboxRow: React.FC<InboxRowProps> = ({
  row,
  selected,
  onSelect,
  onRead,
  onRemove,
}) => {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  const actor = row.actor_name === '' ? 'Someone' : row.actor_name;
  return (
    <li
      ref={ref}
      data-notification-id={row.notification_id}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative flex items-start gap-2.5 border-b border-line px-3 py-2.5 transition-colors duration-100',
        selected ? 'bg-raised' : 'hover:bg-surface'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-2 h-1.5 w-1.5 shrink-0 rounded-full',
          row.unread ? 'bg-accent' : 'bg-transparent'
        )}
      />
      <Avatar name={actor} size="xs" className="mt-0.5 shrink-0" />
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs text-left before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="flex w-full items-center gap-2">
          <span className="shrink-0 font-mono text-2xs text-text-faint">
            {row.issue_key}
          </span>
          <span
            className={cn(
              'truncate text-sm',
              row.unread ? 'font-medium text-text' : 'text-text-muted'
            )}
          >
            {row.issue_title}
          </span>
        </span>
        <span className="flex w-full items-center gap-2 text-xs text-text-muted">
          <span className="truncate">
            {kindLabel(row.kind)}
            {row.actor_name === '' ? '' : ` by ${row.actor_name}`}
          </span>
          <span className="ml-auto shrink-0 tabular-nums text-text-faint">
            {timestampLabel(row.created_at)}
          </span>
        </span>
      </button>
      <span className="relative flex shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        {row.unread && (
          <IconButton
            label={`Mark ${row.issue_key} read`}
            size="sm"
            onClick={onRead}
          >
            <LuCheck className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <IconButton
          label={`Remove ${row.issue_key}`}
          size="sm"
          onClick={onRemove}
        >
          <LuX className="h-3.5 w-3.5" />
        </IconButton>
      </span>
    </li>
  );
};

/** Lists the caller's notifications beside the selected one's issue. */
export const Inbox: React.FC = () => {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const enabled = workspaceId !== '';
  const queryKey = inboxKey(workspaceId, unreadOnly);
  const selectedId = params.get(SELECTED_PARAM);

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

  const selected = useMemo(
    () => rows.find((row) => row.notification_id === selectedId) ?? null,
    [rows, selectedId]
  );
  const selectedIndex = selected === null ? -1 : rows.indexOf(selected);

  const select = useCallback(
    (row: NotificationRead | null) => {
      const next = new URLSearchParams(params);
      if (row === null) {
        next.delete(SELECTED_PARAM);
      } else {
        next.set(SELECTED_PARAM, row.notification_id);
        if (row.unread)
          void readOne(row.notification_id).catch(() => undefined);
      }
      setParams(next, { replace: true });
    },
    [params, setParams, readOne]
  );

  const step = (delta: number): void => {
    if (rows.length === 0) return;
    const from =
      selectedIndex === -1 ? (delta > 0 ? -1 : rows.length) : selectedIndex;
    const to = Math.min(rows.length - 1, Math.max(0, from + delta));
    const row = rows[to];
    if (row !== undefined && row !== selected) select(row);
  };

  const removeRow = (row: NotificationRead): void => {
    if (row === selected) {
      const neighbour =
        rows[selectedIndex + 1] ?? rows[selectedIndex - 1] ?? null;
      select(neighbour);
    }
    void remove(row.notification_id).catch(() => undefined);
  };

  const hasRows = rows.length > 0;
  useShortcut({
    keys: 'j',
    label: 'Next notification',
    group: 'Inbox',
    enabled: hasRows,
    handler: () => {
      step(1);
    },
  });
  useShortcut({
    keys: 'k',
    label: 'Previous notification',
    group: 'Inbox',
    enabled: hasRows,
    handler: () => {
      step(-1);
    },
  });
  useShortcut({
    keys: 'arrowdown',
    label: 'Next notification',
    group: 'Inbox',
    enabled: hasRows,
    handler: () => {
      step(1);
    },
  });
  useShortcut({
    keys: 'arrowup',
    label: 'Previous notification',
    group: 'Inbox',
    enabled: hasRows,
    handler: () => {
      step(-1);
    },
  });
  useShortcut({
    keys: 'enter',
    label: 'Open issue',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      if (selected !== null) void navigate(issuePath(slug, selected.issue_key));
    },
  });
  useShortcut({
    keys: 'backspace',
    label: 'Remove notification',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      if (selected !== null) removeRow(selected);
    },
  });

  const errors = [
    error === null ? null : m3ErrorMessage(error, 'Could not load your inbox.'),
    readError === null
      ? null
      : m3ErrorMessage(readError, 'Could not mark that read.'),
    readAllError === null
      ? null
      : m3ErrorMessage(readAllError, 'Could not mark everything read.'),
    removeError === null
      ? null
      : m3ErrorMessage(removeError, 'Could not remove that row.'),
  ].filter((message): message is string => message !== null);

  return (
    <WorkspaceShell
      title="Inbox"
      flush
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
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Notifications"
          className={cn(
            'min-h-0 w-full shrink-0 flex-col overflow-y-auto border-line lg:w-[380px] lg:border-r',
            selected === null ? 'flex' : 'hidden lg:flex'
          )}
        >
          {errors.length > 0 && (
            <div className="space-y-2 p-3">
              {errors.map((message) => (
                <ErrorAlert key={message} message={message} />
              ))}
            </div>
          )}
          {isLoading ? (
            <div className="p-6">
              <Spinner label="Loading inbox" />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<LuInbox />}
                message={unreadOnly ? 'Nothing unread.' : 'Nothing here yet.'}
              />
            </div>
          ) : (
            <ul>
              {rows.map((row) => (
                <InboxRow
                  key={row.notification_id}
                  row={row}
                  selected={row === selected}
                  onSelect={() => {
                    select(row);
                  }}
                  onRead={() => {
                    void readOne(row.notification_id).catch(() => undefined);
                  }}
                  onRemove={() => {
                    removeRow(row);
                  }}
                />
              ))}
            </ul>
          )}
          {hasMore && (
            <div className="p-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={isPaging}
                onClick={loadMore}
              >
                {isPaging ? 'Loading' : 'Load more'}
              </Button>
            </div>
          )}
        </section>
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1 [&>aside]:w-full [&>aside]:border-l-0',
            selected === null ? 'hidden lg:flex' : 'flex'
          )}
        >
          {selected === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-text-faint">
              <LuInbox aria-hidden="true" className="h-8 w-8" />
              <p>
                {rows.length === 0
                  ? 'You are all caught up.'
                  : 'Select a notification to see its issue.'}
              </p>
            </div>
          ) : (
            <IssuePeek
              key={selected.issue_id}
              issueId={selected.issue_id}
              onClose={() => {
                select(null);
              }}
            />
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
};

export default Inbox;
