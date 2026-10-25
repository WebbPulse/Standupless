/**
 * How the inbox folds notifications into one row per subject, and how its
 * filter and display options become the list query. Grouping runs over the
 * pages already loaded, so it needs no server read and a later page simply
 * joins the groups it belongs to. Quick search and unread first ordering run
 * over the same loaded groups, so typing never waits on the server.
 */

import type { InboxKind, NotificationRead } from '../../types/Api';

/** How each kind of notification reads in the interface. */
export const KIND_LABELS: Record<InboxKind, string> = {
  assigned: 'Assigned to you',
  mentioned: 'Mentioned you',
  commented: 'New comment',
  status_changed: 'Status changed',
  subscribed: 'Subscribed you',
  project_update: 'Project update',
  project_update_comment: 'Reply on update',
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
  triage_new: 'New in triage',
  view_issue_added: 'Added to view',
  reaction: 'Reaction',
  issue_completed: 'Completed',
  issue_cancelled: 'Canceled',
  priority_urgent: 'Marked urgent',
  blocking_changed: 'Blocking changed',
  document_comment: 'Document comment',
};

/** Names a notification's kind, falling back for one added after this build. */
export const kindLabel = (kind: InboxKind): string =>
  KIND_LABELS[kind] ?? 'Update';

/** One inbox row: every loaded notification about one subject, newest first. */
export interface InboxGroup {
  /** The subject the notifications share, stable across refetches. */
  key: string;
  /** The newest notification, which the row reads and the pane opens. */
  latest: NotificationRead;
  /** Every notification in the group, newest first. */
  rows: NotificationRead[];
  /** Whether any notification in the group is unread. */
  unread: boolean;
}

/** Kinds that never fold into an issue's group, since their subject is not an issue. */
const STANDALONE_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>([
  'review_requested',
  'standup_digest',
  'channel_disabled',
  'export_ready',
  'export_failed',
  'import_ready',
  'import_failed',
]);

/** Kinds about a project rather than an issue. */
const PROJECT_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>([
  'project_update',
  'project_update_comment',
  'project_update_due',
]);

/**
 * The subject a notification is grouped under: its issue, its project or its
 * initiative, or the notification alone for a notice with no shared subject.
 */
export const groupKey = (row: NotificationRead): string => {
  const alone = `n:${row.notification_id}`;
  if (PROJECT_KINDS.has(row.kind))
    return row.project_id ? `project:${row.project_id}` : alone;
  if (row.kind === 'initiative_update_due')
    return row.initiative_id ? `initiative:${row.initiative_id}` : alone;
  if (row.kind === 'document_comment')
    return row.document_id ? `document:${row.document_id}` : alone;
  if (STANDALONE_KINDS.has(row.kind) || !row.issue_id) return alone;
  return `issue:${row.issue_id}`;
};

/**
 * Folds a newest first list into groups, each placed where its newest
 * notification sits, so the order still reads newest first.
 */
export const groupNotifications = (rows: NotificationRead[]): InboxGroup[] => {
  const groups: InboxGroup[] = [];
  const byKey = new Map<string, InboxGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    const held = byKey.get(key);
    if (held === undefined) {
      const group: InboxGroup = {
        key,
        latest: row,
        rows: [row],
        unread: row.unread,
      };
      byKey.set(key, group);
      groups.push(group);
    } else {
      held.rows.push(row);
      held.unread = held.unread || row.unread;
    }
  }
  return groups;
};

/** The ids of a group's unread notifications. */
export const unreadIds = (group: InboxGroup): string[] =>
  group.rows.filter((row) => row.unread).map((row) => row.notification_id);

/** The ids of every notification in a group. */
export const groupIds = (group: InboxGroup): string[] =>
  group.rows.map((row) => row.notification_id);

/** When a group comes back, set only while every notification in it is snoozed. */
export const groupSnoozedUntil = (group: InboxGroup): string | null =>
  group.rows.every((row) => row.snoozed_until)
    ? (group.latest.snoozed_until ?? null)
    : null;

/** The ids of a group's snoozed notifications. */
export const snoozedIds = (group: InboxGroup): string[] =>
  group.rows
    .filter((row) => row.snoozed_until)
    .map((row) => row.notification_id);

/** The most ids one mark read call takes. */
export const MARK_BATCH = 100;

/** Splits ids into batches a single write accepts. */
export const batches = (ids: string[], size = MARK_BATCH): string[][] => {
  const out: string[][] = [];
  for (let at = 0; at < ids.length; at += size)
    out.push(ids.slice(at, at + size));
  return out;
};

/** One type the Filter menu offers, and the kinds it stands for. */
export interface InboxCategory {
  id: string;
  label: string;
  kinds: InboxKind[];
}

/** The notification types the Filter menu offers, in the order it lists them. */
export const INBOX_CATEGORIES: InboxCategory[] = [
  { id: 'assignments', label: 'Assignments', kinds: ['assigned'] },
  { id: 'mentions', label: 'Mentions', kinds: ['mentioned'] },
  { id: 'comments', label: 'Comments', kinds: ['commented'] },
  { id: 'reactions', label: 'Reactions', kinds: ['reaction'] },
  {
    id: 'status',
    label: 'Status changes',
    kinds: ['status_changed', 'issue_completed', 'issue_cancelled'],
  },
  { id: 'priority', label: 'Urgent priority', kinds: ['priority_urgent'] },
  { id: 'blocking', label: 'Blocking', kinds: ['blocking_changed'] },
  { id: 'subscriptions', label: 'Subscriptions', kinds: ['subscribed'] },
  {
    id: 'projects',
    label: 'Projects and initiatives',
    kinds: [
      'project_update',
      'project_update_comment',
      'project_update_due',
      'initiative_update_due',
    ],
  },
  { id: 'due', label: 'Due dates', kinds: ['due_soon', 'overdue'] },
  { id: 'reminders', label: 'Reminders', kinds: ['reminder'] },
  { id: 'sla', label: 'SLA', kinds: ['sla_at_risk', 'sla_breached'] },
  { id: 'reviews', label: 'Reviews', kinds: ['review_requested'] },
  { id: 'triage', label: 'Triage', kinds: ['triage_new'] },
  { id: 'views', label: 'Views', kinds: ['view_issue_added'] },
  { id: 'documents', label: 'Documents', kinds: ['document_comment'] },
  { id: 'standups', label: 'Standups', kinds: ['standup_digest'] },
  {
    id: 'notices',
    label: 'Workspace notices',
    kinds: [
      'channel_disabled',
      'export_ready',
      'export_failed',
      'import_ready',
      'import_failed',
    ],
  },
];

/** What the inbox shows: which types, and whether read and snoozed rows stay in. */
export interface InboxView {
  /** The Filter menu's chosen category ids; empty shows every type. */
  categories: string[];
  /** Whether rows already read stay in the list. */
  showRead: boolean;
  /** Whether rows still snoozed stay in the list. */
  showSnoozed: boolean;
  /** Whether unread rows sort above read ones, each part still newest first. */
  unreadFirst: boolean;
}

/** The inbox as it first opens: every type, read rows in, snoozed rows out. */
export const DEFAULT_VIEW: InboxView = {
  categories: [],
  showRead: true,
  showSnoozed: false,
  unreadFirst: false,
};

/** The list query a view reads with. */
export interface InboxViewQuery {
  unread?: boolean;
  include_snoozed?: boolean;
  kind?: string[];
}

/** The kinds a set of category ids stands for, in a stable order. */
export const categoryKinds = (categories: string[]): string[] =>
  INBOX_CATEGORIES.filter((category) => categories.includes(category.id))
    .flatMap((category) => category.kinds)
    .map(String);

/** Turns a view into the list query, leaving out every option at its default. */
export const viewQuery = (view: InboxView): InboxViewQuery => {
  const kinds = categoryKinds(view.categories);
  return {
    ...(view.showRead ? {} : { unread: true }),
    ...(view.showSnoozed ? { include_snoozed: true } : {}),
    ...(kinds.length > 0 ? { kind: kinds } : {}),
  };
};

/** A view as one stable string, for the cache key. */
export const viewSlice = (view: InboxView): string =>
  [
    view.showRead ? 'all' : 'unread',
    view.showSnoozed ? 'snoozed' : 'awake',
    categoryKinds(view.categories).join(','),
  ].join('|');

/** Reads a stored view back, keeping only what still makes sense. */
export const parseView = (raw: string | null): InboxView => {
  if (raw === null) return DEFAULT_VIEW;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return DEFAULT_VIEW;
    const stored = value as Partial<Record<keyof InboxView, unknown>>;
    const known = new Set(INBOX_CATEGORIES.map((category) => category.id));
    return {
      categories: Array.isArray(stored.categories)
        ? stored.categories.filter(
            (id): id is string => typeof id === 'string' && known.has(id)
          )
        : [],
      showRead:
        typeof stored.showRead === 'boolean'
          ? stored.showRead
          : DEFAULT_VIEW.showRead,
      showSnoozed:
        typeof stored.showSnoozed === 'boolean'
          ? stored.showSnoozed
          : DEFAULT_VIEW.showSnoozed,
      unreadFirst:
        typeof stored.unreadFirst === 'boolean'
          ? stored.unreadFirst
          : DEFAULT_VIEW.unreadFirst,
    };
  } catch {
    return DEFAULT_VIEW;
  }
};

/**
 * The team key a notification names: the part of an issue key before its
 * number, or the whole key for a channel or standup notice, which carries the
 * team key alone. Rows whose key is a job id or a pull request name none.
 */
export const teamKeyOf = (row: NotificationRead): string => {
  if (row.kind === 'channel_disabled' || row.kind === 'standup_digest')
    return row.issue_key;
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(row.issue_key);
  return match?.[1] ?? '';
};

/** Everything quick search reads on one notification, lower cased. */
const searchText = (row: NotificationRead): string =>
  [
    row.issue_key,
    row.issue_title,
    kindLabel(row.kind),
    row.actor_name,
    teamKeyOf(row),
    row.project_name ?? '',
    row.initiative_name ?? '',
    row.new_value ?? '',
    row.summary ?? '',
  ]
    .join('\n')
    .toLowerCase();

/**
 * Whether a group answers a quick search. Every word typed must appear in some
 * notification of the group, so "grace eng" finds Grace's comment on ENG-1.
 * An empty search matches everything.
 */
export const matchesSearch = (group: InboxGroup, search: string): boolean => {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = group.rows.map(searchText).join('\n');
  return words.every((word) => text.includes(word));
};

/** The groups a quick search keeps, in their order. */
export const searchGroups = (
  groups: InboxGroup[],
  search: string
): InboxGroup[] =>
  search.trim() === ''
    ? groups
    : groups.filter((group) => matchesSearch(group, search));

/**
 * Orders groups for the Show unread first option: unread above read, each
 * part keeping its newest first order. A group named in `heldUnread` sorts as
 * unread, so the row just opened, and so just marked read, holds its place
 * until the selection moves.
 */
export const orderGroups = (
  groups: InboxGroup[],
  unreadFirst: boolean,
  heldUnread: string | null = null
): InboxGroup[] => {
  if (!unreadFirst) return groups;
  const isUnread = (group: InboxGroup): boolean =>
    group.unread || group.key === heldUnread;
  return [
    ...groups.filter((group) => isUnread(group)),
    ...groups.filter((group) => !isUnread(group)),
  ];
};
