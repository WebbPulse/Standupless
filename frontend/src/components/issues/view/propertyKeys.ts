/**
 * The issue properties the keyboard and the bulk bar can set, and the key
 * each one opens on, shared so the hint in the bar is the key that works.
 */

/** The properties the keyboard can set. */
export type CommandProperty =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'estimate'
  | 'milestone'
  | 'cycle'
  | 'project'
  | 'dueDate';

/** The key each property opens on. */
export const PROPERTY_KEYS: Record<CommandProperty, string> = {
  status: 's',
  priority: 'p',
  assignee: 'a',
  labels: 'l',
  estimate: 'e',
  milestone: 'shift+m',
  cycle: 'shift+c',
  project: 'shift+p',
  dueDate: 'shift+d',
};

/** The key that archives the issues in focus, or restores archived ones. */
export const ARCHIVE_ISSUE_KEYS = '#';

/** The keys that delete the issues in focus, after a confirmation. */
export const DELETE_ISSUE_KEYS = 'mod+backspace';
