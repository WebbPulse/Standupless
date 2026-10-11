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
 * still waiting, and H on a snoozed row offers to unsnooze it now.
 *
 * Opening a row in the Unread tab marks it read without pulling it out from
 * under the reader: the open row holds its place until the selection moves.
 *
 * A project update row names its project rather than an issue, and its pane
 * offers the project's Updates tab, since there is no issue to peek.
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
  LuBellRing,
  LuCalendar,
  LuClock,
  LuDownload,
  LuGitPullRequest,
  LuInbox,
  LuMailOpen,
  LuTarget,
  LuTriangleAlert,
  LuUpload,
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
import IssuePane from '../../components/issues/IssuePane';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import Tooltip from '../../components/ui/tooltip';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useShortcut } from '../../hooks/useShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { viaLabel } from '../../lib/changeSource';
import { cn } from '../../lib/cn';
import { m3ErrorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { compactAge, fullTimestamp } from '../../lib/relativeTime';
import {
  exportSettingsPath,
  importSettingsPath,
  issuePath,
  projectUpdatesTabPath,
  reviewsPath,
  teamSettingsPath,
  teamStandupPath,
} from '../../lib/paths';
import { inboxCountKey, inboxKey, type InboxFilter } from '../../lib/queryKeys';
import type { InboxKind, NotificationRead } from '../../types/Api';
import { keepPinned, type PinnedRow } from './pinned';
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
const KIND_LABELS: Record<InboxKind, string> = {
  assigned: 'Assigned to you',
  mentioned: 'Mentioned you',
  commented: 'New comment',
  status_changed: 'Status changed',
  subscribed: 'Subscribed you',
  project_update: 'Project update',
  project_update_due: 'Update due',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  standup_digest: 'Standup digest',
  sla_at_risk: 'SLA at risk',
  sla_breached: 'SLA breached',
  channel_disabled: 'Channel turned off',
  export_ready: 'Export ready',
  export_failed: 'Export failed',
  import_ready: 'Import finished',
  import_failed: 'Import failed',
  review_requested: 'Review requested',
};

/** Names a notification's kind, falling back for one added after this build. */
const kindLabel = (kind: InboxKind): string => KIND_LABELS[kind] ?? 'Update';

/** Whether a row is about a project update rather than an issue. */
const isProjectRow = (row: NotificationRead): boolean =>
  row.kind === 'project_update' || row.kind === 'project_update_due';

/**
 * Whether a row tells a team admin a Slack or Discord channel was turned off.
 * Its `issue_key` carries the team key and `issue_title` the sentence.
 */
const isChannelRow = (row: NotificationRead): boolean =>
  row.kind === 'channel_disabled';

/**
 * Whether a row tells an admin a workspace export finished or failed. Its
 * `issue_key` carries the export id and `issue_title` the sentence.
 */
const isExportRow = (row: NotificationRead): boolean =>
  row.kind === 'export_ready' || row.kind === 'export_failed';

/**
 * Whether a row tells an admin an issue import finished or failed. Its
 * `issue_key` carries the import id and `issue_title` the sentence.
 */
const isImportRow = (row: NotificationRead): boolean =>
  row.kind === 'import_ready' || row.kind === 'import_failed';

/** Whether a row is a workspace job notice, an export or an import. */
const isJobRow = (row: NotificationRead): boolean =>
  isExportRow(row) || isImportRow(row);

/**
 * Whether a row is a team's scheduled standup digest. Its `issue_key` carries
 * the team key, `issue_title` the team name and `standup_date` the digest date.
 */
const isStandupRow = (row: NotificationRead): boolean =>
  row.kind === 'standup_digest';

/**
 * Whether a row asks the member to review a pull request. Its `issue_key`
 * carries `owner/repo#number`, `issue_title` the pull request title and `url`
 * the pull request on GitHub.
 */
const isReviewRow = (row: NotificationRead): boolean =>
  row.kind === 'review_requested';

/** Opens a review request's pull request on GitHub in a new tab. */
const openPullRequest = (row: NotificationRead): void => {
  if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
};

/** What a row is about, as its actions name it: an issue key, a project or a team standup. */
const subjectName = (row: NotificationRead): string =>
  isProjectRow(row)
    ? (row.project_name ?? 'Project')
    : isChannelRow(row) || isJobRow(row)
      ? row.issue_title
      : isStandupRow(row)
        ? `${row.issue_title} standup`
        : row.issue_key;

/** Where opening a row goes: its issue, its project's updates, team settings, the standup or Reviews. */
const rowPath = (slug: string, row: NotificationRead): string =>
  isReviewRow(row)
    ? reviewsPath(slug)
    : isProjectRow(row)
      ? projectUpdatesTabPath(slug, row.project_id ?? '')
      : isChannelRow(row)
        ? teamSettingsPath(slug, row.issue_key)
        : isExportRow(row)
          ? exportSettingsPath(slug)
          : isImportRow(row)
            ? importSettingsPath(slug)
            : isStandupRow(row)
              ? `${teamStandupPath(slug, row.issue_key)}${
                  row.standup_date
                    ? `?date=${encodeURIComponent(row.standup_date)}`
                    : ''
                }`
              : issuePath(slug, row.issue_key);

/** Props for ReviewRequestPane: the selected row and how to leave it. */
interface ReviewRequestPaneProps {
  row: NotificationRead;
  slug: string;
  onClose: () => void;
}

/** The pane beside a review request, which opens the pull request or the Reviews list. */
const ReviewRequestPane: React.FC<ReviewRequestPaneProps> = ({
  row,
  slug,
  onClose,
}) => {
  const navigate = useNavigate();
  const actor = row.actor_name === '' ? 'Someone' : row.actor_name;
  return (
    <aside
      aria-label="Review request"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <LuGitPullRequest
        aria-hidden="true"
        className="h-8 w-8 text-text-faint"
      />
      <p className="text-sm text-text">
        {actor} requested your review on{' '}
        <span className="font-medium">{row.issue_title}</span>
      </p>
      <p className="font-mono text-xs text-text-muted">{row.issue_key}</p>
      <p className="text-xs text-text-faint">
        {timestampLabel(row.created_at)}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigate(rowPath(slug, row));
          }}
        >
          Open Reviews
        </Button>
        {row.url ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              openPullRequest(row);
            }}
          >
            Open the pull request
          </Button>
        ) : null}
      </div>
    </aside>
  );
};

/** Props for StandupPane: the selected row and how to leave it. */
interface StandupPaneProps {
  row: NotificationRead;
  slug: string;
  onClose: () => void;
}

/** The pane beside a standup digest row, which links to that date's standup page. */
const StandupPane: React.FC<StandupPaneProps> = ({ row, slug, onClose }) => {
  const navigate = useNavigate();
  return (
    <aside
      aria-label="Standup digest"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <LuCalendar aria-hidden="true" className="h-8 w-8 text-text-faint" />
      <p className="text-sm text-text">
        The <span className="font-medium">{row.issue_title}</span> standup
        {row.standup_date ? ` for ${row.standup_date}` : ''} is ready
      </p>
      <p className="text-xs text-text-faint">
        {timestampLabel(row.created_at)}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void navigate(rowPath(slug, row));
          }}
        >
          Open the standup
        </Button>
      </div>
    </aside>
  );
};

/** Props for ChannelNoticePane: the selected row and how to leave it. */
interface ChannelNoticePaneProps {
  row: NotificationRead;
  slug: string;
  onClose: () => void;
}

/** The pane beside a turned-off channel row, which links to team settings. */
const ChannelNoticePane: React.FC<ChannelNoticePaneProps> = ({
  row,
  slug,
  onClose,
}) => {
  const navigate = useNavigate();
  return (
    <aside
      aria-label="Channel notice"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <LuTriangleAlert aria-hidden="true" className="h-8 w-8 text-text-faint" />
      <p className="text-sm text-text">{row.issue_title}</p>
      <p className="text-xs text-text-muted">
        The channel answered that its webhook is gone. Replace the URL or delete
        the channel in team settings.
      </p>
      <p className="text-xs text-text-faint">
        {timestampLabel(row.created_at)}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void navigate(rowPath(slug, row));
          }}
        >
          Open team settings
        </Button>
      </div>
    </aside>
  );
};

/** Props for JobNoticePane: the selected row and how to leave it. */
interface JobNoticePaneProps {
  row: NotificationRead;
  slug: string;
  onClose: () => void;
}

/** What the pane beside a job notice says: its label, its hint and its button. */
interface JobNoticeCopy {
  label: string;
  hint: string;
  action: string;
}

/** The copy for a failed export, which also covers a kind added after this build. */
const EXPORT_FAILED_COPY: JobNoticeCopy = {
  label: 'Export notice',
  hint: 'Nothing was published. Start a new export from the export page.',
  action: 'Open exports',
};

/** What the pane beside a job notice says, by kind. */
const JOB_NOTICE_COPY: Partial<Record<InboxKind, JobNoticeCopy>> = {
  export_ready: {
    label: 'Export notice',
    hint: 'Download links are made fresh on the export page and last 15 minutes.',
    action: 'Open exports',
  },
  export_failed: EXPORT_FAILED_COPY,
  import_ready: {
    label: 'Import notice',
    hint: 'Rows that were skipped and values that were dropped are listed on the import page.',
    action: 'Open imports',
  },
  import_failed: {
    label: 'Import notice',
    hint: 'Issues written before the failure stay. Running the same file again creates them a second time.',
    action: 'Open imports',
  },
};

/** The pane beside a workspace export or import row, which links to its settings page. */
const JobNoticePane: React.FC<JobNoticePaneProps> = ({
  row,
  slug,
  onClose,
}) => {
  const navigate = useNavigate();
  const ready = row.kind === 'export_ready' || row.kind === 'import_ready';
  const copy = JOB_NOTICE_COPY[row.kind] ?? EXPORT_FAILED_COPY;
  const Icon = isImportRow(row) ? LuUpload : LuDownload;
  return (
    <aside
      aria-label={copy.label}
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      {ready ? (
        <Icon aria-hidden="true" className="h-8 w-8 text-text-faint" />
      ) : (
        <LuTriangleAlert
          aria-hidden="true"
          className="h-8 w-8 text-text-faint"
        />
      )}
      <p className="text-sm text-text">{row.issue_title}</p>
      <p className="text-xs text-text-muted">{copy.hint}</p>
      <p className="text-xs text-text-faint">
        {timestampLabel(row.created_at)}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void navigate(rowPath(slug, row));
          }}
        >
          {copy.action}
        </Button>
      </div>
    </aside>
  );
};

/** Props for ProjectUpdatePane: the selected row and how to leave it. */
interface ProjectUpdatePaneProps {
  row: NotificationRead;
  slug: string;
  onClose: () => void;
}

/** The pane beside a project update row, which links to the project. */
const ProjectUpdatePane: React.FC<ProjectUpdatePaneProps> = ({
  row,
  slug,
  onClose,
}) => {
  const navigate = useNavigate();
  const actor = row.actor_name === '' ? 'Someone' : row.actor_name;
  const project = row.project_name ?? 'a project';
  return (
    <aside
      aria-label="Project update"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <LuTarget aria-hidden="true" className="h-8 w-8 text-text-faint" />
      {row.kind === 'project_update_due' ? (
        <p className="text-sm text-text">
          An update is due on <span className="font-medium">{project}</span>
        </p>
      ) : (
        <p className="text-sm text-text">
          <span className="font-medium">{actor}</span> posted an update on{' '}
          <span className="font-medium">{project}</span>
        </p>
      )}
      <p className="text-xs text-text-faint">
        {[timestampLabel(row.created_at), viaLabel(row.source)]
          .filter((part) => part !== null)
          .join(' · ')}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void navigate(rowPath(slug, row));
          }}
        >
          Open project updates
        </Button>
      </div>
    </aside>
  );
};

/** Props for InboxRow. */
interface InboxRowProps {
  row: NotificationRead;
  selected: boolean;
  onSelect: () => void;
  onToggleRead: () => void;
  onSnooze: () => void;
  onRemove: () => void;
}

/** One notification: who did what to which issue or project, and its row actions. */
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
        selected
          ? 'bg-raised'
          : 'hover:bg-surface has-[button:active]:bg-raised'
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
        data-hover="parent"
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs text-left before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="flex w-full items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              row.unread ? 'font-medium text-text' : 'text-text-muted'
            )}
          >
            {isProjectRow(row) || isStandupRow(row)
              ? subjectName(row)
              : row.issue_title}
          </span>
          <Tooltip text={fullTimestamp(row.created_at)} side="top">
            <time
              dateTime={row.created_at}
              aria-label={fullTimestamp(row.created_at)}
              className="shrink-0 text-xs tabular-nums text-text-faint"
            >
              {compactAge(row.created_at)}
            </time>
          </Tooltip>
        </span>
        <span className="flex w-full items-center gap-1.5 text-xs text-text-muted">
          {isProjectRow(row) ? (
            <LuTarget
              aria-hidden="true"
              className="h-3 w-3 shrink-0 text-text-faint"
            />
          ) : isExportRow(row) ? (
            <LuDownload
              aria-hidden="true"
              className="h-3 w-3 shrink-0 text-text-faint"
            />
          ) : isImportRow(row) ? (
            <LuUpload
              aria-hidden="true"
              className="h-3 w-3 shrink-0 text-text-faint"
            />
          ) : isStandupRow(row) ? (
            <LuCalendar
              aria-hidden="true"
              className="h-3 w-3 shrink-0 text-text-faint"
            />
          ) : (
            <span className="shrink-0 font-mono text-2xs text-text-faint">
              {row.issue_key}
            </span>
          )}
          <span className="min-w-0 truncate">
            {row.snoozed_until
              ? snoozeLabel(row.snoozed_until)
              : [
                  kindLabel(row.kind),
                  row.actor_name === '' ? null : `by ${row.actor_name}`,
                  viaLabel(row.source),
                ]
                  .filter((part) => part !== null)
                  .join(' ')}
          </span>
        </span>
      </button>
      <span className="relative flex shrink-0 items-center gap-0.5 opacity-100 sm:pointer-fine:absolute sm:pointer-fine:right-2 sm:pointer-fine:bottom-1.5 sm:pointer-fine:rounded-sm sm:pointer-fine:bg-raised sm:pointer-fine:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        {row.unread ? (
          <IconButton
            label={`Mark ${subjectName(row)} read`}
            size="sm"
            onClick={onToggleRead}
          >
            <LuCheck className="h-3.5 w-3.5" />
          </IconButton>
        ) : (
          <IconButton
            label={`Mark ${subjectName(row)} unread`}
            size="sm"
            onClick={onToggleRead}
          >
            <LuMailOpen className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <IconButton
          label={`Snooze ${subjectName(row)}`}
          size="sm"
          onClick={onSnooze}
        >
          <LuClock className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          label={`Remove ${subjectName(row)}`}
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
  const [pinned, setPinned] = useState<PinnedRow | null>(null);

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
      keepPinned(
        fetched.map((row) => {
          const held = unreadOverrides[row.notification_id];
          return held === undefined || held.was !== row.unread
            ? row
            : { ...row, unread: held.unread };
        }),
        pinned,
        selectedId
      ),
    [fetched, unreadOverrides, pinned, selectedId]
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

  const everyKey = [
    inboxKey(workspaceId, 'all'),
    inboxKey(workspaceId, 'unread'),
    inboxKey(workspaceId, 'snoozed'),
    inboxCountKey(workspaceId),
  ];

  const { mutate: snooze, error: snoozeError } = useMutationWithRefetch(
    ({ notificationId, until }: { notificationId: string; until: string }) =>
      snoozeNotifications(workspaceId, {
        notification_ids: [notificationId],
        until,
      }),
    everyKey
  );

  const { mutate: unsnooze, error: unsnoozeError } = useMutationWithRefetch(
    (notificationId: string) =>
      markUnread(workspaceId, { notification_ids: [notificationId] }),
    everyKey
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
        setPinned(null);
      } else {
        next.set(SELECTED_PARAM, row.notification_id);
        setPinned({
          row: { ...row, unread: false },
          index: Math.max(0, rows.indexOf(row)),
        });
        if (row.unread)
          void readOne(row.notification_id).catch(() => undefined);
      }
      setParams(next, { replace: true });
    },
    [params, setParams, readOne, rows]
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

  const unsnoozeRow = (row: NotificationRead): void => {
    setSnoozing(null);
    if (filter === 'snoozed') stepPast(row);
    void unsnooze(row.notification_id).catch(() => undefined);
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
    label: 'Open notification',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      if (selected === null) return;
      if (isReviewRow(selected) && selected.url) openPullRequest(selected);
      else void navigate(rowPath(slug, selected));
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
    unsnoozeError === null
      ? null
      : m3ErrorMessage(unsnoozeError, 'Could not unsnooze that.'),
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
                  setPinned(null);
                }}
                className={cn(
                  'rounded-sm px-2 py-0.5 text-xs transition-colors pointer-coarse:px-3 pointer-coarse:py-2.5 duration-100 focus-visible:outline-2 focus-visible:outline-accent',
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
            <span className="sr-only sm:not-sr-only">
              {isReadingAll ? 'Marking' : 'Mark all read'}
            </span>
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Notifications"
          className={cn(
            'min-h-0 w-full shrink-0 flex-col overflow-y-auto border-line lg:w-[300px] lg:border-r',
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
          ) : isReviewRow(selected) ? (
            <ReviewRequestPane
              key={selected.notification_id}
              row={selected}
              slug={slug}
              onClose={() => {
                select(null);
              }}
            />
          ) : isJobRow(selected) ? (
            <JobNoticePane
              key={selected.notification_id}
              row={selected}
              slug={slug}
              onClose={() => {
                select(null);
              }}
            />
          ) : isChannelRow(selected) ? (
            <ChannelNoticePane
              key={selected.notification_id}
              row={selected}
              slug={slug}
              onClose={() => {
                select(null);
              }}
            />
          ) : isStandupRow(selected) ? (
            <StandupPane
              key={selected.notification_id}
              row={selected}
              slug={slug}
              onClose={() => {
                select(null);
              }}
            />
          ) : isProjectRow(selected) ? (
            <ProjectUpdatePane
              key={selected.notification_id}
              row={selected}
              slug={slug}
              onClose={() => {
                select(null);
              }}
            />
          ) : (
            <IssuePane
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
        description={`${snoozing === null ? 'It' : subjectName(snoozing)} comes back unread at the time you pick.`}
        size="sm"
      >
        <ul className="flex flex-col gap-1">
          {snoozing?.snoozed_until ? (
            <li>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  unsnoozeRow(snoozing);
                }}
              >
                <LuBellRing className="h-3.5 w-3.5" aria-hidden="true" />
                Unsnooze now
              </Button>
            </li>
          ) : null}
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
