/**
 * How the inbox folds notifications into one row per subject, and how its
 * filter and display options become the list query. Grouping runs over the
 * pages already loaded, so it needs no server read and a later page simply
 * joins the groups it belongs to.
 */

import type { InboxKind, NotificationRead } from '../../types/Api';

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
  { id: 'status', label: 'Status changes', kinds: ['status_changed'] },
  { id: 'subscriptions', label: 'Subscriptions', kinds: ['subscribed'] },
  {
    id: 'projects',
    label: 'Projects and initiatives',
    kinds: ['project_update', 'project_update_due', 'initiative_update_due'],
  },
  { id: 'due', label: 'Due dates', kinds: ['due_soon', 'overdue'] },
  { id: 'sla', label: 'SLA', kinds: ['sla_at_risk', 'sla_breached'] },
  { id: 'reviews', label: 'Reviews', kinds: ['review_requested'] },
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
}

/** The inbox as it first opens: every type, read rows in, snoozed rows out. */
export const DEFAULT_VIEW: InboxView = {
  categories: [],
  showRead: true,
  showSnoozed: false,
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
    };
  } catch {
    return DEFAULT_VIEW;
  }
};
