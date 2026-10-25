/**
 * The Cmd or Ctrl+Alt+1 to 9 status shortcuts, as in Linear: each digit sets
 * the issues in focus to the status in that position of their own team's
 * workflow, in the order the status picker lists it, without opening the
 * picker.
 */

import type { IssueChange } from './issueView';
import { sortStatuses } from './propertyOptions';
import { showToast } from './toast';
import type { IssueRead, StatusRead } from '../types/Api';

/** How many workflow positions have a shortcut of their own. */
export const STATUS_POSITION_COUNT = 9;

/** The 1-based positions that have a shortcut. */
export const STATUS_POSITIONS: readonly number[] = Array.from(
  { length: STATUS_POSITION_COUNT },
  (_, index) => index + 1
);

/** The label the help panel lists every status position shortcut under. */
export const STATUS_POSITION_LABEL = 'Set status 1 to 9';

/** The registry keys that set the status at a 1-based workflow position. */
export const statusPositionKeys = (position: number): string =>
  `mod+alt+${String(position)}`;

/** Whether a registry `keys` string is one of the status position shortcuts. */
export const isStatusPositionKeys = (keys: string): boolean =>
  /^mod\+alt\+[1-9]$/.test(keys);

/** The fields of an issue the status position shortcuts read. */
export type StatusPositionIssue = Pick<
  IssueRead,
  'id' | 'team_id' | 'status_id' | 'in_triage'
>;

/** A team's workflow statuses, in any order. */
export type TeamStatuses = (teamId: string) => readonly StatusRead[];

/** Writes one change to the issues named. */
export type StatusPositionWrite = (
  ids: readonly string[],
  change: IssueChange
) => void;

/** The status at a 1-based position of a workflow, in picker order. */
export const statusAtPosition = (
  statuses: readonly StatusRead[],
  position: number
): StatusRead | undefined =>
  position < 1 || position > STATUS_POSITION_COUNT
    ? undefined
    : sortStatuses([...statuses])[position - 1];

/** The issues grouped by their team, in first-seen order. */
const byTeam = <T extends StatusPositionIssue>(
  issues: readonly T[]
): Map<string, T[]> => {
  const teams = new Map<string, T[]>();
  for (const issue of issues) {
    const held = teams.get(issue.team_id) ?? [];
    held.push(issue);
    teams.set(issue.team_id, held);
  }
  return teams;
};

/**
 * What the shortcut at a position is called: the status it sets when every
 * team in focus has the same one there, or the position otherwise.
 */
export const statusPositionLabel = (
  issues: readonly StatusPositionIssue[],
  position: number,
  statusesFor: TeamStatuses
): string => {
  const names = new Set(
    [...byTeam(issues).keys()].map(
      (teamId) => statusAtPosition(statusesFor(teamId), position)?.name ?? ''
    )
  );
  const [only] = names;
  return names.size === 1 && only !== undefined && only !== ''
    ? `Set status to ${only}`
    : `Set status ${String(position)}`;
};

/**
 * Sets each issue to the status at a position of its own team's workflow,
 * one write per team, leaving out the issues already there. A team with
 * fewer statuses than the position changes nothing and raises a notice.
 */
export const setStatusByPosition = (
  issues: readonly StatusPositionIssue[],
  position: number,
  statusesFor: TeamStatuses,
  write: StatusPositionWrite
): void => {
  let missing = 0;
  for (const [teamId, members] of byTeam(issues)) {
    const status = statusAtPosition(statusesFor(teamId), position);
    if (status === undefined) {
      missing += members.length;
      continue;
    }
    const ids = members
      .filter(
        (issue) => issue.status_id !== status.id || issue.in_triage === true
      )
      .map((issue) => issue.id);
    if (ids.length > 0) write(ids, { status_id: status.id });
  }
  if (missing === 0) return;
  showToast(
    missing === issues.length
      ? `No status in position ${String(position)} of this workflow`
      : `${String(missing)} of ${String(issues.length)} issues skipped: their team has fewer than ${String(position)} statuses`
  );
};
