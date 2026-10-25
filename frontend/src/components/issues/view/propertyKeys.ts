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

/** The key that renames the issue in focus. */
export const RENAME_ISSUE_KEYS = 'r';

/** The keys that put the issues in focus into their team's active cycle. */
export const ADD_TO_ACTIVE_CYCLE_KEYS = 'mod+shift+c';

/** The keys that clear the due date of the issues in focus. */
export const REMOVE_DUE_DATE_KEYS = 'mod+shift+d';

/**
 * The keys that clear every label from the issues in focus. Shift+L is the
 * board's label picker, so this takes the Cmd or Ctrl+Shift form the cycle
 * and due date actions use.
 */
export const REMOVE_LABELS_KEYS = 'mod+shift+l';

/** The keys that move to the comment box of the issue in view. */
export const COMMENT_ISSUE_KEYS = 'mod+m';

/**
 * The keys that subscribe to or unsubscribe from an issue, the same in the
 * issue view and the inbox, as in Linear.
 */
export const TOGGLE_SUBSCRIPTION_KEYS = 'mod+shift+s';

/**
 * The key each property opens on in a layout. The board gives `l` to moving
 * to the next column, as `h` moves to the previous one, so labels move to
 * Shift+L there.
 */
export const propertyKeysFor = (
  layout: 'list' | 'board'
): Record<CommandProperty, string> =>
  layout === 'board' ? { ...PROPERTY_KEYS, labels: 'shift+l' } : PROPERTY_KEYS;
