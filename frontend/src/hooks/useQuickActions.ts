/**
 * The one-key property actions that skip a picker: Cmd or Ctrl+Shift+C puts
 * the issues in focus into their team's active cycle, Cmd or Ctrl+Shift+D
 * clears their due date and Cmd or Ctrl+Shift+L clears their labels. Each
 * writes through the surface's own update, so a list batches the issues into
 * bulk requests where the bulk route takes the field, and undo records them.
 */

import { useShortcut, type ShortcutScope } from './useShortcuts';
import {
  ADD_TO_ACTIVE_CYCLE_KEYS,
  REMOVE_DUE_DATE_KEYS,
  REMOVE_LABELS_KEYS,
} from '../components/issues/view/propertyKeys';
import { findActiveCycle } from '../lib/currentCycle';
import { errorMessage } from '../lib/errors';
import type { IssueChange } from '../lib/issueView';
import { showErrorToast, showToast } from '../lib/toast';
import type { CycleRead, IssueRead } from '../types/Api';

/** The palette and help labels of the quick actions. */
export const ADD_TO_ACTIVE_CYCLE_LABEL = 'Add to active cycle';
export const REMOVE_DUE_DATE_LABEL = 'Remove due date';
export const REMOVE_LABELS_LABEL = 'Remove all labels';

/** The notice when no target's team has a running cycle. */
export const NO_ACTIVE_CYCLE_MESSAGE = 'No active cycle for this team';

/** The fields of an issue the quick actions read. */
export type QuickActionIssue = Pick<
  IssueRead,
  'id' | 'team_id' | 'cycle_id' | 'due_date' | 'label_ids'
>;

/** Writes one change to the issues named. */
export type QuickActionWrite = (
  ids: readonly string[],
  change: IssueChange
) => void;

/** Finds a team's running cycle, or null when none runs. */
export type ActiveCycleFinder = (
  workspaceId: string,
  teamId: string
) => Promise<CycleRead | null>;

/** Every label any of the issues carries, once each. */
export const appliedLabelIds = (
  issues: readonly QuickActionIssue[]
): string[] => [...new Set(issues.flatMap((issue) => issue.label_ids))];

/** The running cycle among those already held for a team, if one is. */
export const heldActiveCycle = (
  cycles: readonly CycleRead[],
  teamId: string
): CycleRead | undefined =>
  cycles.find(
    (cycle) =>
      cycle.team_id === teamId && cycle.status === 'active' && !cycle.cancelled
  );

/** The issues grouped by their team, in first-seen order. */
const byTeam = (
  issues: readonly QuickActionIssue[]
): Map<string, QuickActionIssue[]> => {
  const teams = new Map<string, QuickActionIssue[]>();
  for (const issue of issues) {
    const held = teams.get(issue.team_id) ?? [];
    held.push(issue);
    teams.set(issue.team_id, held);
  }
  return teams;
};

/**
 * Puts each issue into its team's running cycle, one write per team, and
 * leaves out the ones already there. A team with no running cycle changes
 * nothing and raises a notice.
 */
export const addToActiveCycle = async (
  workspaceId: string,
  issues: readonly QuickActionIssue[],
  write: QuickActionWrite,
  cyclesFor: (teamId: string) => readonly CycleRead[] = () => [],
  find: ActiveCycleFinder = findActiveCycle
): Promise<void> => {
  let missing = 0;
  for (const [teamId, members] of byTeam(issues)) {
    let cycle: CycleRead | null;
    try {
      cycle =
        heldActiveCycle(cyclesFor(teamId), teamId) ??
        (workspaceId === '' ? null : await find(workspaceId, teamId));
    } catch (cause) {
      showErrorToast(errorMessage(cause, 'Could not find the active cycle.'));
      return;
    }
    if (cycle === null) {
      missing += members.length;
      continue;
    }
    const cycleId = cycle.cycle_id;
    const ids = members
      .filter((issue) => issue.cycle_id !== cycleId)
      .map((issue) => issue.id);
    if (ids.length > 0) write(ids, { cycle_id: cycleId });
  }
  if (missing > 0) {
    showToast(
      missing === issues.length
        ? NO_ACTIVE_CYCLE_MESSAGE
        : `${String(missing)} of ${String(issues.length)} issues skipped: their team has no active cycle`
    );
  }
};

/** Clears the due date of the issues that have one. */
export const removeDueDate = (
  issues: readonly QuickActionIssue[],
  write: QuickActionWrite
): void => {
  const ids = issues
    .filter((issue) => issue.due_date !== null)
    .map((issue) => issue.id);
  if (ids.length > 0) write(ids, { due_date: null });
};

/** Clears every label from the issues that carry any, in one change. */
export const removeLabels = (
  issues: readonly QuickActionIssue[],
  write: QuickActionWrite
): void => {
  const carrying = issues.filter((issue) => issue.label_ids.length > 0);
  if (carrying.length === 0) return;
  write(
    carrying.map((issue) => issue.id),
    { remove_label_ids: appliedLabelIds(carrying) }
  );
};

/** What {@link useQuickActions} binds against. */
export interface QuickActionsOptions {
  workspaceId: string;
  issues: readonly QuickActionIssue[];
  /** Whether the viewer can edit the issues. */
  enabled: boolean;
  write: QuickActionWrite;
  /** The cycles already held for a team, checked before asking the server. */
  cyclesFor?: (teamId: string) => readonly CycleRead[];
  scope?: ShortcutScope;
  group?: string;
}

/** Binds the quick actions to their keys and the palette. */
export const useQuickActions = ({
  workspaceId,
  issues,
  enabled,
  write,
  cyclesFor,
  scope = 'issue',
  group,
}: QuickActionsOptions): void => {
  const live = enabled && issues.length > 0;
  const grouped = group === undefined ? {} : { group };
  useShortcut({
    keys: ADD_TO_ACTIVE_CYCLE_KEYS,
    label: ADD_TO_ACTIVE_CYCLE_LABEL,
    scope,
    ...grouped,
    enabled: live,
    handler: (event) => {
      event?.preventDefault();
      void addToActiveCycle(workspaceId, issues, write, cyclesFor);
    },
  });
  useShortcut({
    keys: REMOVE_DUE_DATE_KEYS,
    label: REMOVE_DUE_DATE_LABEL,
    scope,
    ...grouped,
    enabled: live && issues.some((issue) => issue.due_date !== null),
    handler: (event) => {
      event?.preventDefault();
      removeDueDate(issues, write);
    },
  });
  useShortcut({
    keys: REMOVE_LABELS_KEYS,
    label: REMOVE_LABELS_LABEL,
    scope,
    ...grouped,
    enabled: live && issues.some((issue) => issue.label_ids.length > 0),
    handler: (event) => {
      event?.preventDefault();
      removeLabels(issues, write);
    },
  });
};
