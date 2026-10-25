/**
 * The ways an issue leaves the triage inbox, in the order Linear shows them:
 * 1 accepts, 2 declines, 3 or M M marks as a duplicate, and H snoozes. The
 * row buttons, the toolbar, the keyboard help sheet and the command palette
 * all read this one list, so the number keys always match the order on screen.
 */

import type { StatusRead } from '../types/Api';

/** One triage action's id. */
export type TriageActionId = 'accept' | 'decline' | 'duplicate' | 'snooze';

/** One triage action: the key that runs it and what it is called. */
export interface TriageAction {
  id: TriageActionId;
  keys: string;
  /** A second key sequence that runs the same action, as Linear's M M does. */
  altKeys?: string;
  label: string;
  /** The shorter name the toolbar button shows. */
  short: string;
}

/** Each triage action by id. */
export const TRIAGE_ACTION: Readonly<Record<TriageActionId, TriageAction>> = {
  accept: { id: 'accept', keys: '1', label: 'Accept', short: 'Accept' },
  decline: { id: 'decline', keys: '2', label: 'Decline', short: 'Decline' },
  duplicate: {
    id: 'duplicate',
    keys: '3',
    altKeys: 'm m',
    label: 'Mark as duplicate',
    short: 'Duplicate',
  },
  snooze: { id: 'snooze', keys: 'h', label: 'Snooze', short: 'Snooze' },
};

/** Every triage action, in on-screen and number-key order. */
export const TRIAGE_ACTIONS: readonly TriageAction[] = [
  TRIAGE_ACTION.accept,
  TRIAGE_ACTION.decline,
  TRIAGE_ACTION.duplicate,
  TRIAGE_ACTION.snooze,
];

/**
 * The status an accept defaults to: the team's lowest-position visible
 * unstarted status, as the server picks when none is named, or null when the
 * team has none.
 */
export const defaultAcceptStatus = (
  statuses: readonly StatusRead[]
): StatusRead | null =>
  statuses
    .filter((status) => status.category === 'unstarted' && !status.hidden)
    .sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name)
    )[0] ?? null;
