/**
 * The caller's notifications as a split pane: the list on the left and the
 * selected notification's issue on the right, so triage runs down the list
 * without leaving it. There is no recipient parameter anywhere on this page:
 * the partition is built from the session, so a person can only ever read
 * their own rows and the page never has to decide whose inbox it is showing.
 * The selection lives in the URL, so a link lands on the same row.
 *
 * Triage runs from the keyboard the way Linear's does: U toggles read and
 * unread, H snoozes until a chosen moment, Backspace removes, and Shift R
 * marks everything read. A snoozed row leaves the list and the badge and comes
 * back unread on its own when its time comes; the Snoozed tab lists what is
 * still waiting.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  LuCheck,
  LuCheckCheck,
  LuClock,
  LuInbox,
  LuMailOpen,
  LuX,
} from 'react-icons/lu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  appendNotifications,
  deleteNotification,
  listInbox,
  markAllRead,
  markRead,
  markUnread,
  snoozeNotifications,
} from '../../api/views';
import IssuePeek from '../../components/issues/IssuePeek';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
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
import { inboxCountKey, inboxKey, type InboxFilter } from '../../lib/queryKeys';
import type { NotificationKind, NotificationRead } from '../../types/Api';
import { SNOOZE_PRESETS, snoozeLabel } from './snooze';

/** How often the inbox re-reads, matching the badge so the two agree. */
const POLL_MS = 60000;

/** How many rows a page holds. */
const PAGE_SIZE = 50;

/** The URL parameter holding the selected notification. */
const SELECTED_PARAM = 'n';

/** The inbox slices, in the order the tabs show them. */
const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'snoozed', label: 'Snoozed' },
];

/** What an empty list says, per slice. */
const EMPTY_MESSAGES: Record<InboxFilter, string> = {
  all: 'Nothing here yet.',
  unread: 'Nothing unread.',
  snoozed: 'Nothing snoozed.',
};

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
  onToggleRead: () => void;
  onSnooze: () => void;
  onRemove: () => void;
}

/** One notification: who did what to which issue, and its row actions. */
const InboxRow: React.FC<InboxRowProps> = ({
  row,
  selected,
  onSelect,
  onToggleRead,
  onSnooze,
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
            {row.snoozed_until
              ? snoozeLabel(row.snoozed_until)
              : `${kindLabel(row.kind)}${
                  row.actor_name === '' ? '' : ` by ${row.actor_name}`
                }`}
          </span>
          <span className="ml-auto shrink-0 tabular-nums text-text-faint">
            {timestampLabel(row.created_at)}
          </span>
        </span>
      </button>
      <span className="relative flex shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        {row.unread ? (
          <IconButton
            label={`Mark ${row.issue_key} read`}
            size="sm"
            onClick={onToggleRead}
          >
            <LuCheck className="h-3.5 w-3.5" />
          </IconButton>
        ) : (
          <IconButton
            label={`Mark ${row.issue_key} unread`}
            size="sm"
            onClick={onToggleRead}
          >
            <LuMailOpen className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <IconButton
          label={`Snooze ${row.issue_key}`}
          size="sm"
          onClick={onSnooze}
        >
          <LuClock className="h-3.5 w-3.5" />
        </IconButton>
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

/**
 * A read state set here ahead of the server, and the server's state it was set
 * against. It applies only while the fetched row still shows that state, so it
 * lapses by itself once a refetch catches up or the row changes some other way.
 */
interface UnreadOverride {
  unread: boolean;
  was: boolean;
}

/** Lists the caller's notifications beside the selected one's issue. */
export const Inbox: React.FC = () => {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [unreadOverrides, setUnreadOverrides] = useState<
    Record<string, UnreadOverride>
  >({});
  const [snoozing, setSnoozing] = useState<NotificationRead | null>(null);

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const enabled = workspaceId !== '';
  const queryKey = inboxKey(workspaceId, filter);
  const selectedId = params.get(SELECTED_PARAM);

  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listInbox(
        workspaceId,
        {
          ...(filter === 'unread' ? { unread: true } : {}),
          ...(filter === 'snoozed' ? { snoozed: true } : {}),
          ...(cursor === undefined ? {} : { cursor }),
          limit: PAGE_SIZE,
        },
        signal
      ).then((page) => ({
        rows: page.notifications,
        nextCursor: page.next_cursor,
      })),
    [workspaceId, filter]
  );

  const merge = useCallback(
    (held: NotificationRead[], incoming: NotificationRead[]) =>
      appendNotifications(held, incoming),
    []
  );

  const {
    rows: fetched,
    error,
    isLoading,
    isPaging,
    hasMore,
    loadMore,
  } = useCursorPages(read, merge, { queryKey, enabled, intervalMs: POLL_MS });

  const rows = useMemo(
    () =>
      fetched.map((row) => {
        const held = unreadOverrides[row.notification_id];
        return held === undefined || held.was !== row.unread
          ? row
          : { ...row, unread: held.unread };
      }),
    [fetched, unreadOverrides]
  );

  const setUnread = useCallback(
    (notificationId: string, unread: boolean) => {
      const row = fetched.find((one) => one.notification_id === notificationId);
      if (row === undefined) return;
      setUnreadOverrides((held) => ({
        ...held,
        [notificationId]: { unread, was: row.unread },
      }));
    },
    [fetched]
  );

  const refetchKeys = [queryKey, inboxCountKey(workspaceId)];

  const { mutate: readOne, error: readError } = useMutationWithRefetch(
    (notificationId: string) => {
      setUnread(notificationId, false);
      return markRead(workspaceId, { notification_ids: [notificationId] });
    },
    refetchKeys
  );

  const { mutate: unreadOne, error: unreadError } = useMutationWithRefetch(
    (notificationId: string) => {
      setUnread(notificationId, true);
      return markUnread(workspaceId, { notification_ids: [notificationId] });
    },
    refetchKeys
  );

  const { mutate: snooze, error: snoozeError } = useMutationWithRefetch(
    ({ notificationId, until }: { notificationId: string; until: string }) =>
      snoozeNotifications(workspaceId, {
        notification_ids: [notificationId],
        until,
      }),
    [
      inboxKey(workspaceId, 'all'),
      inboxKey(workspaceId, 'unread'),
      inboxKey(workspaceId, 'snoozed'),
      inboxCountKey(workspaceId),
    ]
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

  const stepPast = (row: NotificationRead): void => {
    if (row !== selected) return;
    const neighbour =
      rows[selectedIndex + 1] ?? rows[selectedIndex - 1] ?? null;
    select(neighbour);
  };

  const removeRow = (row: NotificationRead): void => {
    stepPast(row);
    void remove(row.notification_id).catch(() => undefined);
  };

  const toggleRead = (row: NotificationRead): void => {
    if (row.unread) void readOne(row.notification_id).catch(() => undefined);
    else void unreadOne(row.notification_id).catch(() => undefined);
  };

  const snoozeRow = (row: NotificationRead, until: Date): void => {
    setSnoozing(null);
    stepPast(row);
    void snooze({
      notificationId: row.notification_id,
      until: until.toISOString(),
    }).catch(() => undefined);
  };

  const readEverything = (): void => {
    setUnreadOverrides(
      Object.fromEntries(
        fetched.map((row) => [
          row.notification_id,
          { unread: false, was: row.unread },
        ])
      )
    );
    void readAll().catch(() => undefined);
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
    keys: 'escape',
    label: 'Close notification',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      select(null);
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

  useShortcut({
    keys: 'u',
    label: 'Toggle read or unread',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      if (selected !== null) toggleRead(selected);
    },
  });
  useShortcut({
    keys: 'h',
    label: 'Snooze notification',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      if (selected !== null) setSnoozing(selected);
    },
  });
  useShortcut({
    keys: 'shift+r',
    label: 'Mark all read',
    group: 'Inbox',
    enabled: hasRows && !isReadingAll,
    handler: () => {
      readEverything();
    },
  });

  const errors = [
    error === null ? null : m3ErrorMessage(error, 'Could not load your inbox.'),
    readError === null
      ? null
      : m3ErrorMessage(readError, 'Could not mark that read.'),
    unreadError === null
      ? null
      : m3ErrorMessage(unreadError, 'Could not mark that unread.'),
    snoozeError === null
      ? null
      : m3ErrorMessage(snoozeError, 'Could not snooze that.'),
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
          <div
            role="group"
            aria-label="Show"
            className="mr-2 flex items-center gap-0.5 rounded-md border border-line p-0.5"
          >
            {FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={filter === option.id}
                onClick={() => {
                  setFilter(option.id);
                }}
                className={cn(
                  'rounded-sm px-2 py-0.5 text-xs transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-accent',
                  filter === option.id
                    ? 'bg-raised text-text'
                    : 'text-text-muted hover:text-text'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={isReadingAll || rows.length === 0}
            onClick={readEverything}
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
            <div className="p-6 lg:hidden">
              <EmptyState icon={<LuInbox />} message={EMPTY_MESSAGES[filter]} />
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
                  onToggleRead={() => {
                    toggleRead(row);
                  }}
                  onSnooze={() => {
                    setSnoozing(row);
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
      <Dialog
        open={snoozing !== null}
        onClose={() => {
          setSnoozing(null);
        }}
        title="Snooze notification"
        description={`${snoozing?.issue_key ?? 'It'} comes back unread at the time you pick.`}
        size="sm"
      >
        <ul className="flex flex-col gap-1">
          {SNOOZE_PRESETS.map((preset) => (
            <li key={preset.id}>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  if (snoozing !== null)
                    snoozeRow(snoozing, preset.until(new Date()));
                }}
              >
                <LuClock className="h-3.5 w-3.5" aria-hidden="true" />
                {preset.label}
              </Button>
            </li>
          ))}
        </ul>
      </Dialog>
    </WorkspaceShell>
  );
};

export default Inbox;
