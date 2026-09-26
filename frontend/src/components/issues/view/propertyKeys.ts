/**
 * The issue properties the keyboard and the bulk bar can set, and the key
 * each one opens on, shared so the hint in the bar is the key that works.
 */

/** The properties the keyboard can set. */
export type CommandProperty =
  'status' | 'priority' | 'assignee' | 'labels' | 'estimate';

/** The key each property opens on. */
export const PROPERTY_KEYS: Record<CommandProperty, string> = {
  status: 's',
  priority: 'p',
  assignee: 'a',
  labels: 'l',
  estimate: 'e',
};
