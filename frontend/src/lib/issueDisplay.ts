/**
 * How the issue shapes read in the interface. Kept apart from the components so
 * the same wording is used by the list, the detail page and the activity feed,
 * and so it can be tested without rendering anything.
 */

import type {
  ActivityRead,
  IssuePriority,
  IssueProgress,
  IssueSort,
  LinkType,
} from '../types/Api';

/** The priorities in the order the contract lists them, worst first. */
export const PRIORITIES: IssuePriority[] = [
  'none',
  'urgent',
  'high',
  'medium',
  'low',
];

/** How a priority reads in the interface. */
export const PRIORITY_LABELS: Record<IssuePriority, string> = {
  none: 'No priority',
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** The sort orders the list route accepts, with the default first. */
export const SORTS: IssueSort[] = [
  'updated_desc',
  'created_desc',
  'key_asc',
  'priority_desc',
  'due_asc',
];

/** How a sort order reads in the interface. */
export const SORT_LABELS: Record<IssueSort, string> = {
  updated_desc: 'Recently updated',
  created_desc: 'Recently created',
  key_asc: 'Key',
  priority_desc: 'Priority',
  due_asc: 'Due date',
};

/** The link types a caller may write. The inverses arrive only on a read. */
export const LINK_TYPES: LinkType[] = [
  'blocks',
  'blocked_by',
  'relates_to',
  'duplicate_of',
];

/** How a link type reads in the interface. */
export const LINK_TYPE_LABELS: Record<string, string> = {
  blocks: 'Blocks',
  blocked_by: 'Blocked by',
  relates_to: 'Relates to',
  duplicate_of: 'Duplicate of',
  duplicated_by: 'Duplicated by',
};

/**
 * How a link type reads, falling back to the raw value so an inverse the
 * contract adds later still renders rather than disappearing.
 */
export const linkTypeLabel = (type: string): string =>
  LINK_TYPE_LABELS[type] ?? type;

/** How an activity entry's kind reads when it names no field. */
const ACTIVITY_KIND_LABELS: Record<string, string> = {
  created: 'created this issue',
  link_added: 'added a link',
  link_removed: 'removed a link',
  child_added: 'added a sub-issue',
  child_removed: 'removed a sub-issue',
};

/** How a changed field name reads in the interface. */
const FIELD_LABELS: Record<string, string> = {
  title: 'the title',
  body: 'the description',
  status_id: 'the status',
  priority: 'the priority',
  assignee_id: 'the assignee',
  label_ids: 'the labels',
  estimate: 'the estimate',
  start_date: 'the start date',
  due_date: 'the due date',
  parent_id: 'the parent',
  cycle_id: 'the cycle',
  project_id: 'the project',
};

/**
 * Plain words for a machine name the tables above do not know yet, so a field
 * or kind added after this build never shows up in snake case.
 */
export const humanizeName = (name: string): string =>
  name
    .replace(/_ids?$/, '')
    .replace(/[._]+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * The sentence one activity entry reads as. Ids are left to the caller to
 * resolve, so this says what changed rather than guessing at a name the feed
 * has no list to look up.
 */
export const activitySentence = (entry: ActivityRead): string => {
  if (entry.kind === 'field_changed') {
    if (entry.field === 'github_commit') {
      return typeof entry.to === 'string' && entry.to !== ''
        ? `mentioned this issue in a commit to ${entry.to}`
        : 'mentioned this issue in a commit';
    }
    if (entry.field === null || entry.field === '') return 'changed a field';
    return `changed ${FIELD_LABELS[entry.field] ?? `the ${humanizeName(entry.field)}`}`;
  }
  return ACTIVITY_KIND_LABELS[entry.kind] ?? humanizeName(entry.kind);
};

/** The completed share of an issue's direct children, as a 0 to 100 integer. */
export const progressPercent = (progress: IssueProgress): number => {
  if (progress.total <= 0) return 0;
  return Math.round((progress.completed / progress.total) * 100);
};

/** How a date the API returns reads in the interface, or a word when unset. */
export const dateLabel = (value: string | null): string => value ?? 'Not set';

/** How a timestamp reads in the feed: the date and time in the local zone. */
export const timestampLabel = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};
