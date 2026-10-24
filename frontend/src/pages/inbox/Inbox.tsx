/**
 * The caller's notifications as a split pane: the list on the left and the
 * selected notification's issue on the right, so triage runs down the list
 * without leaving it. There is no recipient parameter anywhere on this page:
 * the partition is built from the session, so a person can only ever read
 * their own rows and the page never has to decide whose inbox it is showing.
 * The selection lives in the URL, so a link lands on the same row.
 *
 * Notifications about one issue, project or initiative fold into one row that
 * reads the newest change, who made it and how many there are, and opening
 * the row marks every one of them read. Filter narrows the list to chosen
 * notification types, and Display decides whether read and snoozed rows stay.
 *
 * Triage runs from the keyboard the way Linear's does: U toggles read and
 * unread, H snoozes until a chosen moment, Backspace removes, and Shift R
 * marks everything read. A snoozed row leaves the list and the badge and comes
 * back unread on its own when its time comes; Show snoozed lists what is still
 * waiting, and H on a snoozed row offers to unsnooze it now.
 *
 * Every row also offers its actions to the mouse: hover or select it for
 * quick buttons, or right click it, or press its "more" button, for the full
 * menu, which adds unsubscribing from the issue, copying its link and opening
 * the row in a new tab. Shift S toggles the subscription on the selected
 * row's issue, so the pane beside it gives that key up while the inbox shows
 * it.
 *
 * Removing, snoozing or unsubscribing raises a notice with Undo, and Ctrl Z
 * puts it back too. There is no route that restores a deleted notification,
 * so a removed row is only hidden here until its Undo window lapses, and the
 * delete is sent then, or sooner when the page is left.
 *
 * Opening a row while read rows are hidden marks it read without pulling it
 * out from under the reader: the open row holds its place until the selection
 * moves.
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
import {
  invalidateQueries,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  LuCheck,
  LuCheckCheck,
  LuCalendar,
  LuClock,
  LuDownload,
  LuEllipsis,
  LuGitPullRequest,
  LuGoal,
  LuInbox,
  LuMailOpen,
  LuTarget,
  LuTrash2,
  LuTriangleAlert,
  LuUpload,
  LuX,
} from 'react-icons/lu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  appendNotifications,
  clearInbox,
  deleteNotification,
  listInbox,
  markAllRead,
  markRead,
  markUnread,
  snoozeNotifications,
} from '../../api/views';
import {
  listSubscribers,
  subscribe,
  unsubscribe,
} from '../../api/notifications';
import IssuePane from '../../components/issues/IssuePane';
import { ManageSubscribersKeyContext } from '../../components/issues/IssueSubscribers';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import {
  ContextMenu,
  Menu,
  MenuItem,
  MenuSeparator,
} from '../../components/ui/menu';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import Tooltip from '../../components/ui/tooltip';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCursorPages } from '../../hooks/useCursorPages';
import { displayKeys, useShortcut } from '../../hooks/useShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { viaLabel } from '../../lib/changeSource';
import { cn } from '../../lib/cn';
import { copyText, issueUrl } from '../../lib/copyIssue';
import { errorMessage, m3ErrorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { compactAge, fullTimestamp } from '../../lib/relativeTime';
import { showErrorToast, showToast } from '../../lib/toast';
import { pushUndo, UNDO_TOAST_MS } from '../../lib/undo';
import {
  exportSettingsPath,
  importSettingsPath,
  initiativePath,
  integrationsSettingsPath,
  issuePath,
  projectUpdatesTabPath,
  reviewsPath,
  teamSettingsPath,
  teamStandupPath,
} from '../../lib/paths';
import { inboxCountKey, inboxKey, subscribersKey } from '../../lib/queryKeys';
import type { InboxKind, NotificationRead } from '../../types/Api';
import {
  DEFAULT_VIEW,
  batches,
  groupIds,
  groupNotifications,
  groupSnoozedUntil,
  parseView,
  snoozedIds,
  unreadIds,
  viewQuery,
  viewSlice,
  type InboxGroup,
  type InboxView,
} from './groups';
import {
  InboxRowMenuItems,
  REMOVE_KEYS,
  SNOOZE_KEYS,
  TOGGLE_READ_KEYS,
  TOGGLE_SUBSCRIPTION_KEYS,
} from './InboxRowMenu';
import { InboxDisplayMenu, InboxFilterMenu } from './InboxViewMenus';
import { keepPinned, type PinnedRow } from './pinned';
import SnoozeDialog from './SnoozeDialog';
import { snoozeLabel } from './snooze';

/** How often the inbox re-reads, matching the badge so the two agree. */
const POLL_MS = 60000;

/** How many rows a page holds. */
const PAGE_SIZE = 50;

/** The URL parameter holding the selected notification. */
const SELECTED_PARAM = 'n';

/** How each kind of notification reads in the interface. */
const KIND_LABELS: Record<InboxKind, string> = {
  assigned: 'Assigned to you',
  mentioned: 'Mentioned you',
  commented: 'New comment',
  status_changed: 'Status changed',
  subscribed: 'Subscribed you',
  project_update: 'Project update',
  project_update_due: 'Update due',
  initiative_update_due: 'Initiative update due',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  reminder: 'Reminder',
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
 * Whether a row reminds an initiative's owner that its update is due or
 * overdue. It is workspace level, so `team_id` is empty and the issue fields
 * are blank; `initiative_name` and `due_state` carry what it says.
 */
const isInitiativeRow = (row: NotificationRead): boolean =>
  row.kind === 'initiative_update_due';

/** The link to one initiative's updates tab. */
const initiativeUpdatesTabPath = (slug: string, initiativeId: string): string =>
  `${initiativePath(slug, initiativeId)}?tab=updates`;

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

/**
 * Whether a row is about one issue, so it offers the issue-only actions:
 * unsubscribing and copying the issue's link.
 */
const isIssueRow = (row: NotificationRead): boolean =>
  row.issue_id !== '' &&
  !isProjectRow(row) &&
  !isInitiativeRow(row) &&
  !isChannelRow(row) &&
  !isJobRow(row) &&
  !isStandupRow(row) &&
  !isReviewRow(row);

/** Opens a review request's pull request on GitHub in a new tab. */
const openPullRequest = (row: NotificationRead): void => {
  if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
};

/** What a row is about, as its actions name it: an issue key, a project, an initiative or a team standup. */
const subjectName = (row: NotificationRead): string =>
  isProjectRow(row)
    ? (row.project_name ?? 'Project')
    : isInitiativeRow(row)
      ? (row.initiative_name ?? 'Initiative')
      : isChannelRow(row) || isJobRow(row)
        ? row.issue_title
        : isStandupRow(row)
          ? `${row.issue_title} standup`
          : row.issue_key;

/** Where opening a row goes: its issue, its project's or initiative's updates, team settings, the standup or Reviews. */
const rowPath = (slug: string, row: NotificationRead): string =>
  isReviewRow(row)
    ? reviewsPath(slug)
    : isProjectRow(row)
      ? projectUpdatesTabPath(slug, row.project_id ?? '')
      : isInitiativeRow(row)
        ? initiativeUpdatesTabPath(slug, row.initiative_id ?? '')
        : isChannelRow(row)
          ? row.issue_key
            ? teamSettingsPath(slug, row.issue_key)
            : integrationsSettingsPath(slug)
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

/** The pane beside a turned-off channel row, which links to team settings, or the integrations page for a workspace channel. */
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
        {row.issue_key
          ? 'The channel answered that its webhook is gone. Replace the URL or delete the channel in team settings.'
          : 'The channel answered that it is gone. Pick another channel or delete it in workspace integrations.'}
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
          {row.issue_key ? 'Open team settings' : 'Open integrations'}
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

/** Props for InitiativeUpdatePane: the selected row and how to leave it. */
interface InitiativeUpdatePaneProps {
  row: NotificationRead;
  slug: string;
  onClose: () => void;
}

/** The pane beside an initiative update reminder, which links to the initiative's updates. */
const InitiativeUpdatePane: React.FC<InitiativeUpdatePaneProps> = ({
  row,
  slug,
  onClose,
}) => {
  const navigate = useNavigate();
  const initiative = row.initiative_name ?? 'an initiative';
  const state = row.due_state === 'overdue' ? 'overdue' : 'due';
  return (
    <aside
      aria-label="Initiative update"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <LuGoal aria-hidden="true" className="h-8 w-8 text-text-faint" />
      <p className="text-sm text-text">
        An update is {state} on{' '}
        <span className="font-medium">{initiative}</span>
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
          Open initiative updates
        </Button>
      </div>
    </aside>
  );
};

/** The line a row reads: the server's summary, or a label built here for an older row. */
const rowSummary = (row: NotificationRead): string => {
  if (row.summary) return row.summary;
  const label =
    isInitiativeRow(row) && row.due_state === 'overdue'
      ? 'Initiative update overdue'
      : kindLabel(row.kind);
  return row.actor_name === '' ? label : `${label} by ${row.actor_name}`;
};

/** Props for InboxRow. */
interface InboxRowProps {
  group: InboxGroup;
  selected: boolean;
  onSelect: () => void;
  onToggleRead: () => void;
  onSnooze: () => void;
  onRemove: () => void;
  /** Opens the row's context menu at the pointer. */
  onContextMenu: (x: number, y: number) => void;
  /** The entries the row's "more" button lists. */
  menu: React.ReactNode;
}

/** A tooltip's text: what a quick button does and the key that does the same. */
const actionTip = (label: string, keys: string): string =>
  `${label} (${displayKeys(keys)[0] ?? ''})`;

/** Props for RowAction: one quick button on a row. */
interface RowActionProps {
  /** The name the button is announced with. */
  label: string;
  /** The tooltip, which names the shortcut too. */
  tip: string;
  onClick: () => void;
  children: React.ReactNode;
}

/** One quick button on a row, tipped with what it does and its key. */
const RowAction: React.FC<RowActionProps> = ({
  label,
  tip,
  onClick,
  children,
}) => (
  <Tooltip text={tip}>
    <Button
      aria-label={label}
      size="sm"
      variant="ghost"
      className="w-7 px-0 pointer-coarse:w-11"
      onClick={onClick}
    >
      {children}
    </Button>
  </Tooltip>
);

/** One subject's notifications as one row: its newest change, who made it, and how many there are. */
const InboxRow: React.FC<InboxRowProps> = ({
  group,
  selected,
  onSelect,
  onToggleRead,
  onSnooze,
  onRemove,
  onContextMenu,
  menu,
}) => {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  const row = group.latest;
  const actor = row.actor_name === '' ? 'Someone' : row.actor_name;
  const count = group.rows.length;
  const snoozedUntil = groupSnoozedUntil(group);
  return (
    <li
      ref={ref}
      data-notification-id={row.notification_id}
      aria-current={selected ? 'true' : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
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
          group.unread ? 'bg-accent' : 'bg-transparent'
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
              group.unread ? 'font-medium text-text' : 'text-text-muted'
            )}
          >
            {isProjectRow(row) || isInitiativeRow(row) || isStandupRow(row)
              ? subjectName(row)
              : row.issue_title}
          </span>
          {count > 1 && (
            <span
              aria-label={`${count} notifications`}
              className="shrink-0 rounded-sm bg-surface px-1 text-2xs tabular-nums text-text-muted"
            >
              {count}
            </span>
          )}
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
          ) : isInitiativeRow(row) ? (
            <LuGoal
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
            {snoozedUntil
              ? snoozeLabel(snoozedUntil)
              : [rowSummary(row), viaLabel(row.source)]
                  .filter((part) => part !== null)
                  .join(' ')}
          </span>
        </span>
      </button>
      <span
        className={cn(
          'relative flex shrink-0 items-center gap-0.5 opacity-100 sm:pointer-fine:absolute sm:pointer-fine:right-2 sm:pointer-fine:bottom-1.5 sm:pointer-fine:rounded-sm sm:pointer-fine:bg-raised sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
          selected ? 'sm:pointer-fine:opacity-100' : 'sm:pointer-fine:opacity-0'
        )}
      >
        {group.unread ? (
          <RowAction
            label={`Mark ${subjectName(row)} read`}
            tip={actionTip('Mark as read', TOGGLE_READ_KEYS)}
            onClick={onToggleRead}
          >
            <LuCheck aria-hidden="true" className="h-3.5 w-3.5" />
          </RowAction>
        ) : (
          <RowAction
            label={`Mark ${subjectName(row)} unread`}
            tip={actionTip('Mark as unread', TOGGLE_READ_KEYS)}
            onClick={onToggleRead}
          >
            <LuMailOpen aria-hidden="true" className="h-3.5 w-3.5" />
          </RowAction>
        )}
        <RowAction
          label={`Snooze ${subjectName(row)}`}
          tip={actionTip('Snooze', SNOOZE_KEYS)}
          onClick={onSnooze}
        >
          <LuClock aria-hidden="true" className="h-3.5 w-3.5" />
        </RowAction>
        <RowAction
          label={`Remove ${subjectName(row)}`}
          tip={actionTip('Delete notification', REMOVE_KEYS)}
          onClick={onRemove}
        >
          <LuX aria-hidden="true" className="h-3.5 w-3.5" />
        </RowAction>
        <Menu
          label={`${subjectName(row)} actions`}
          align="end"
          trigger={(trigger) => (
            <IconButton
              label={`More actions for ${subjectName(row)}`}
              size="sm"
              {...trigger}
            >
              <LuEllipsis className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          )}
        >
          {menu}
        </Menu>
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

/** A removal waiting out its Undo window: the notifications it deletes and the timer that sends it. */
interface HeldRemoval {
  ids: string[];
  timer: ReturnType<typeof setTimeout>;
}

/** A row's context menu, open at the pointer. */
interface RowMenuAt {
  group: InboxGroup;
  x: number;
  y: number;
}

/** Where the inbox keeps the viewer's filter and display choices between visits. */
const VIEW_STORAGE_KEY = 'standupless.inbox.view';

/** The stored view, or the default when storage is empty or out of reach. */
const loadView = (): InboxView => {
  try {
    return parseView(globalThis.localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return DEFAULT_VIEW;
  }
};

/** Remembers a view for the next visit, quietly when storage is out of reach. */
const storeView = (view: InboxView): void => {
  try {
    globalThis.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    return;
  }
};

/** What an empty list says, given the view that emptied it. */
const emptyMessage = (view: InboxView): string =>
  view.categories.length > 0
    ? 'Nothing matches this filter.'
    : view.showRead
      ? 'Nothing here yet.'
      : 'Nothing unread.';

/** Lists the caller's notifications, one row per subject, beside the selected one's issue. */
/** Which rows a bulk delete removes: the read ones or every one. */
type ClearScope = 'read' | 'all';

/** What a bulk delete confirmation says it removes under the current view. */
const clearDescription = (scope: ClearScope, view: InboxView): string => {
  const filtered = view.categories.length > 0 ? ' of the filtered types' : '';
  if (scope === 'read')
    return `Every read notification${filtered} is deleted. Unread and snoozed ones stay. This cannot be undone.`;
  const snoozed = view.showSnoozed
    ? ', snoozed ones included'
    : '. Snoozed ones stay';
  return `Every notification${filtered} is deleted${snoozed}. This cannot be undone.`;
};

/** The notice a finished bulk delete raises. */
const deletedLabel = (deleted: number): string =>
  deleted === 1
    ? 'Deleted 1 notification'
    : `Deleted ${String(deleted)} notifications`;

export const Inbox: React.FC = () => {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<InboxView>(loadView);
  const [unreadOverrides, setUnreadOverrides] = useState<
    Record<string, UnreadOverride>
  >({});
  const [snoozing, setSnoozing] = useState<InboxGroup | null>(null);
  const [pinned, setPinned] = useState<PinnedRow | null>(null);
  const [clearing, setClearing] = useState<ClearScope | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuAt | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const holds = useRef(new Map<number, HeldRemoval>());
  const nextHold = useRef(1);

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const enabled = workspaceId !== '';
  const queryKey = inboxKey(workspaceId, viewSlice(view));
  const query = useMemo(() => viewQuery(view), [view]);
  const selectedId = params.get(SELECTED_PARAM);

  const changeView = useCallback((next: InboxView) => {
    setView(next);
    storeView(next);
    setPinned(null);
  }, []);

  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listInbox(
        workspaceId,
        {
          ...query,
          ...(cursor === undefined ? {} : { cursor }),
          limit: PAGE_SIZE,
        },
        signal
      ).then((page) => ({
        rows: page.notifications,
        nextCursor: page.next_cursor,
      })),
    [workspaceId, query]
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

  const groups = useMemo(
    () =>
      keepPinned(
        groupNotifications(
          fetched.flatMap((row) => {
            if (hidden.has(row.notification_id)) return [];
            const held = unreadOverrides[row.notification_id];
            return [
              held === undefined || held.was !== row.unread
                ? row
                : { ...row, unread: held.unread },
            ];
          })
        ),
        pinned,
        selectedId
      ),
    [fetched, hidden, unreadOverrides, pinned, selectedId]
  );

  const setUnread = useCallback(
    (notificationIds: string[], unread: boolean) => {
      const wanted = new Set(notificationIds);
      setUnreadOverrides((held) => {
        const next = { ...held };
        for (const row of fetched) {
          if (wanted.has(row.notification_id))
            next[row.notification_id] = { unread, was: row.unread };
        }
        return next;
      });
    },
    [fetched]
  );

  const refetchKeys = [queryKey, inboxCountKey(workspaceId)];

  const { mutate: readMany, error: readError } = useMutationWithRefetch(
    (notificationIds: string[]) => {
      setUnread(notificationIds, false);
      return Promise.all(
        batches(notificationIds).map((batch) =>
          markRead(workspaceId, { notification_ids: batch })
        )
      );
    },
    refetchKeys
  );

  const { mutate: unreadMany, error: unreadError } = useMutationWithRefetch(
    (notificationIds: string[]) => {
      setUnread(notificationIds, true);
      return markUnread(workspaceId, { notification_ids: notificationIds });
    },
    refetchKeys
  );

  const { mutate: snooze, error: snoozeError } = useMutationWithRefetch(
    ({
      notificationIds,
      until,
    }: {
      notificationIds: string[];
      until: string;
    }) =>
      Promise.all(
        batches(notificationIds).map((batch) =>
          snoozeNotifications(workspaceId, { notification_ids: batch, until })
        )
      ),
    refetchKeys
  );

  const { mutate: unsnooze, error: unsnoozeError } = useMutationWithRefetch(
    (notificationIds: string[]) =>
      markUnread(workspaceId, { notification_ids: notificationIds }),
    refetchKeys
  );

  const {
    mutate: readAll,
    isMutating: isReadingAll,
    error: readAllError,
  } = useMutationWithRefetch(() => markAllRead(workspaceId), refetchKeys);

  const {
    mutate: clearAll,
    isMutating: isClearing,
    error: clearError,
  } = useMutationWithRefetch(
    (scope: ClearScope) =>
      clearInbox(workspaceId, {
        read_only: scope === 'read',
        ...(query.include_snoozed === true ? { include_snoozed: true } : {}),
        ...(query.kind === undefined ? {} : { kinds: query.kind }),
      }),
    refetchKeys
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (notificationIds: string[]) =>
      Promise.all(
        notificationIds.map((notificationId) =>
          deleteNotification(workspaceId, notificationId)
        )
      ),
    refetchKeys
  );

  const removeRef = useRef(remove);
  useEffect(() => {
    removeRef.current = remove;
  }, [remove]);

  useEffect(() => {
    const held = holds.current;
    const flush = (): void => {
      const pending = [...held.values()];
      held.clear();
      for (const hold of pending) {
        clearTimeout(hold.timer);
        for (const id of hold.ids)
          void deleteNotification(workspaceId, id).catch(() => undefined);
      }
      if (pending.length > 0) invalidateQueries([inboxCountKey(workspaceId)]);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [workspaceId]);

  const hide = useCallback((ids: string[], on: boolean) => {
    setHidden((held) => {
      const next = new Set(held);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const commitRemoval = useCallback(
    (holdId: number) => {
      const hold = holds.current.get(holdId);
      if (hold === undefined) return;
      holds.current.delete(holdId);
      void removeRef.current(hold.ids).catch(() => {
        hide(hold.ids, false);
      });
    },
    [hide]
  );

  const selected = useMemo(
    () =>
      selectedId === null
        ? null
        : (groups.find((group) =>
            group.rows.some((row) => row.notification_id === selectedId)
          ) ?? null),
    [groups, selectedId]
  );
  const selectedIndex = selected === null ? -1 : groups.indexOf(selected);

  const select = useCallback(
    (group: InboxGroup | null) => {
      const next = new URLSearchParams(params);
      if (group === null) {
        next.delete(SELECTED_PARAM);
        setPinned(null);
      } else {
        next.set(SELECTED_PARAM, group.latest.notification_id);
        setPinned({
          group: {
            ...group,
            unread: false,
            latest: { ...group.latest, unread: false },
            rows: group.rows.map((row) => ({ ...row, unread: false })),
          },
          index: Math.max(0, groups.indexOf(group)),
        });
        const ids = unreadIds(group);
        if (ids.length > 0) void readMany(ids).catch(() => undefined);
      }
      setParams(next, { replace: true });
    },
    [params, setParams, readMany, groups]
  );

  const step = (delta: number): void => {
    if (groups.length === 0) return;
    const from =
      selectedIndex === -1 ? (delta > 0 ? -1 : groups.length) : selectedIndex;
    const to = Math.min(groups.length - 1, Math.max(0, from + delta));
    const group = groups[to];
    if (group !== undefined && group !== selected) select(group);
  };

  const stepPast = (group: InboxGroup): void => {
    if (group !== selected) return;
    const neighbour =
      groups[selectedIndex + 1] ?? groups[selectedIndex - 1] ?? null;
    select(neighbour);
  };

  const removeGroup = (group: InboxGroup): void => {
    stepPast(group);
    const ids = groupIds(group);
    hide(ids, true);
    const holdId = nextHold.current;
    nextHold.current += 1;
    holds.current.set(holdId, {
      ids,
      timer: setTimeout(() => {
        commitRemoval(holdId);
      }, UNDO_TOAST_MS),
    });
    pushUndo(workspaceId, `Removed ${subjectName(group.latest)}`, () => {
      const hold = holds.current.get(holdId);
      if (hold === undefined)
        return Promise.reject(new Error('The notification is already gone.'));
      clearTimeout(hold.timer);
      holds.current.delete(holdId);
      hide(ids, false);
      return Promise.resolve();
    });
  };

  const toggleRead = (group: InboxGroup): void => {
    if (group.unread) void readMany(unreadIds(group)).catch(() => undefined);
    else void unreadMany([group.latest.notification_id]).catch(() => undefined);
  };

  const snoozeGroup = (group: InboxGroup, until: Date): void => {
    setSnoozing(null);
    if (!view.showSnoozed) stepPast(group);
    const ids = groupIds(group);
    const wasRead = group.rows
      .filter((row) => !row.unread)
      .map((row) => row.notification_id);
    const keys = refetchKeys;
    const landed = snooze({
      notificationIds: ids,
      until: until.toISOString(),
    }).then(
      () => true,
      () => false
    );
    pushUndo(workspaceId, `Snoozed ${subjectName(group.latest)}`, async () => {
      if (!(await landed)) return;
      try {
        await Promise.all(
          batches(ids).map((batch) =>
            markUnread(workspaceId, { notification_ids: batch })
          )
        );
        await Promise.all(
          batches(wasRead).map((batch) =>
            markRead(workspaceId, { notification_ids: batch })
          )
        );
      } finally {
        invalidateQueries(keys);
      }
    });
  };

  const unsnoozeGroup = (group: InboxGroup): void => {
    setSnoozing(null);
    void unsnooze(snoozedIds(group)).catch(() => undefined);
  };

  const changeSubscription = (group: InboxGroup, joining: boolean): void => {
    const { issue_id: issueId, issue_key: issueKey } = group.latest;
    const keys = [subscribersKey(workspaceId, issueId)];
    const request = joining
      ? subscribe(workspaceId, issueId)
      : unsubscribe(workspaceId, issueId);
    void request
      .then(() => {
        invalidateQueries(keys);
        if (joining) {
          showToast(`Subscribed to ${issueKey}`);
          return;
        }
        pushUndo(workspaceId, `Unsubscribed from ${issueKey}`, async () => {
          try {
            await subscribe(workspaceId, issueId);
          } finally {
            invalidateQueries(keys);
          }
        });
      })
      .catch((failure: unknown) => {
        showErrorToast(
          errorMessage(failure, 'Could not change your subscription.')
        );
      });
  };

  const toggleSubscription = (group: InboxGroup): void => {
    void listSubscribers(workspaceId, group.latest.issue_id)
      .then((read) => {
        changeSubscription(group, !read.subscribed);
      })
      .catch((failure: unknown) => {
        showErrorToast(
          errorMessage(failure, 'Could not read your subscription.')
        );
      });
  };

  const openInNewTab = (row: NotificationRead): void => {
    const target =
      isReviewRow(row) && row.url
        ? row.url
        : new URL(rowPath(slug, row), globalThis.location.origin).toString();
    window.open(target, '_blank', 'noopener,noreferrer');
  };

  const rowMenuItems = (group: InboxGroup): React.ReactNode => (
    <InboxRowMenuItems
      workspaceId={workspaceId}
      group={group}
      issueRow={isIssueRow(group.latest)}
      onToggleRead={() => {
        toggleRead(group);
      }}
      onSnooze={() => {
        setSnoozing(group);
      }}
      onRemove={() => {
        removeGroup(group);
      }}
      onSubscription={(joining) => {
        changeSubscription(group, joining);
      }}
      onCopyLink={() => {
        copyText(
          issueUrl(slug, group.latest.issue_key),
          'Link to the issue copied'
        );
      }}
      onOpenInNewTab={() => {
        openInNewTab(group.latest);
      }}
    />
  );

  const closeRowMenu = useCallback(() => {
    setRowMenu(null);
  }, []);

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

  const clearEverything = (scope: ClearScope): void => {
    setClearing(null);
    select(null);
    void clearAll(scope)
      .then((deleted) => {
        showToast(deletedLabel(deleted));
      })
      .catch(() => undefined);
  };

  const hasRows = groups.length > 0;
  const current = selected?.latest ?? null;
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
    enabled: current !== null,
    handler: () => {
      if (current === null) return;
      if (isReviewRow(current) && current.url) openPullRequest(current);
      else void navigate(rowPath(slug, current));
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
    keys: REMOVE_KEYS,
    label: 'Remove notification',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      if (selected !== null) removeGroup(selected);
    },
  });

  useShortcut({
    keys: TOGGLE_READ_KEYS,
    label: 'Toggle read or unread',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      if (selected !== null) toggleRead(selected);
    },
  });
  useShortcut({
    keys: SNOOZE_KEYS,
    label: 'Snooze notification',
    group: 'Inbox',
    enabled: selected !== null,
    handler: () => {
      if (selected !== null) setSnoozing(selected);
    },
  });
  useShortcut({
    keys: TOGGLE_SUBSCRIPTION_KEYS,
    label: 'Toggle subscription to issue',
    group: 'Inbox',
    enabled: selected !== null && isIssueRow(selected.latest),
    handler: () => {
      if (selected !== null) toggleSubscription(selected);
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
    clearError === null
      ? null
      : m3ErrorMessage(clearError, 'Could not delete those notifications.'),
  ].filter((message): message is string => message !== null);

  const closePane = (): void => {
    select(null);
  };

  return (
    <WorkspaceShell
      title="Inbox"
      flush
      actions={
        <div className="flex items-center gap-1.5">
          <InboxFilterMenu view={view} onChange={changeView} />
          <InboxDisplayMenu view={view} onChange={changeView} />
          <Menu
            label="Inbox actions"
            align="end"
            trigger={(trigger) => (
              <IconButton label="Inbox actions" size="sm" {...trigger}>
                <LuEllipsis className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
            )}
          >
            <MenuItem
              disabled={isReadingAll || groups.length === 0}
              onSelect={readEverything}
            >
              <LuCheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Mark all read
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              disabled={isClearing}
              onSelect={() => {
                setClearing('read');
              }}
            >
              <LuTrash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete all read notifications
            </MenuItem>
            <MenuItem
              danger
              disabled={isClearing}
              onSelect={() => {
                setClearing('all');
              }}
            >
              <LuTrash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete all notifications
            </MenuItem>
          </Menu>
        </div>
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
          ) : groups.length === 0 ? (
            <div className="p-6 lg:hidden">
              <EmptyState icon={<LuInbox />} message={emptyMessage(view)} />
            </div>
          ) : (
            <ul>
              {groups.map((group) => (
                <InboxRow
                  key={group.key}
                  group={group}
                  selected={group === selected}
                  onSelect={() => {
                    select(group);
                  }}
                  onToggleRead={() => {
                    toggleRead(group);
                  }}
                  onSnooze={() => {
                    setSnoozing(group);
                  }}
                  onRemove={() => {
                    removeGroup(group);
                  }}
                  onContextMenu={(x, y) => {
                    setRowMenu({ group, x, y });
                  }}
                  menu={rowMenuItems(group)}
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
          {current === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-text-faint">
              <LuInbox aria-hidden="true" className="h-8 w-8" />
              <p>
                {groups.length === 0
                  ? 'You are all caught up.'
                  : 'Select a notification to see its issue.'}
              </p>
            </div>
          ) : isReviewRow(current) ? (
            <ReviewRequestPane
              key={current.notification_id}
              row={current}
              slug={slug}
              onClose={closePane}
            />
          ) : isJobRow(current) ? (
            <JobNoticePane
              key={current.notification_id}
              row={current}
              slug={slug}
              onClose={closePane}
            />
          ) : isChannelRow(current) ? (
            <ChannelNoticePane
              key={current.notification_id}
              row={current}
              slug={slug}
              onClose={closePane}
            />
          ) : isStandupRow(current) ? (
            <StandupPane
              key={current.notification_id}
              row={current}
              slug={slug}
              onClose={closePane}
            />
          ) : isInitiativeRow(current) ? (
            <InitiativeUpdatePane
              key={current.notification_id}
              row={current}
              slug={slug}
              onClose={closePane}
            />
          ) : isProjectRow(current) ? (
            <ProjectUpdatePane
              key={current.notification_id}
              row={current}
              slug={slug}
              onClose={closePane}
            />
          ) : (
            <ManageSubscribersKeyContext.Provider value={false}>
              <IssuePane
                key={current.issue_id}
                issueId={current.issue_id}
                onClose={closePane}
              />
            </ManageSubscribersKeyContext.Provider>
          )}
        </div>
      </div>
      {rowMenu !== null && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          label={`${subjectName(rowMenu.group.latest)} actions`}
          onClose={closeRowMenu}
        >
          {rowMenuItems(rowMenu.group)}
        </ContextMenu>
      )}
      <SnoozeDialog
        open={snoozing !== null}
        subject={snoozing === null ? 'It' : subjectName(snoozing.latest)}
        snoozed={snoozing !== null && snoozedIds(snoozing).length > 0}
        onSnooze={(until) => {
          if (snoozing !== null) snoozeGroup(snoozing, until);
        }}
        onUnsnooze={() => {
          if (snoozing !== null) unsnoozeGroup(snoozing);
        }}
        onClose={() => {
          setSnoozing(null);
        }}
      />
      <Dialog
        open={clearing !== null}
        onClose={() => {
          setClearing(null);
        }}
        title={
          clearing === 'read'
            ? 'Delete all read notifications'
            : 'Delete all notifications'
        }
        description={clearDescription(clearing ?? 'all', view)}
        size="sm"
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setClearing(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (clearing !== null) clearEverything(clearing);
            }}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </WorkspaceShell>
  );
};

export default Inbox;
