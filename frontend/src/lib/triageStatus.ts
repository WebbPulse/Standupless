/**
 * Triage shown as a status. An issue waiting in its team's triage inbox keeps
 * the `in_triage` flag and a hidden real status; every surface shows it under
 * the synthetic Triage status instead, and every status picker on a team with
 * triage on offers Triage first, as Linear does.
 */

import type { StatusRead } from '../types/Api';
import { TRIAGE_STATUS_ID } from './statusAppearance';

export { TRIAGE_STATUS_ID } from './statusAppearance';

/** The name the synthetic Triage status shows under. */
export const TRIAGE_STATUS_NAME = 'Triage';

/** The group and option key Triage sits under, apart from every real status's key. */
export const TRIAGE_GROUP_KEY = TRIAGE_STATUS_ID;

/**
 * The synthetic Triage status as a status row, so pickers, rows and groups can
 * hold it like any other. Its category is backlog, waiting work, so any surface
 * that reads only the category still draws something sensible.
 */
export const TRIAGE_STATUS: StatusRead = {
  id: TRIAGE_STATUS_ID,
  name: TRIAGE_STATUS_NAME,
  category: 'backlog',
  position: -1,
  color: null,
  icon: null,
};

/** The synthetic Triage status scoped to one team, for lists that span teams. */
export const triageStatusFor = (
  teamId?: string
): StatusRead & { team_id?: string } =>
  teamId === undefined ? TRIAGE_STATUS : { ...TRIAGE_STATUS, team_id: teamId };

/** Whether a status id is the synthetic Triage one. */
export const isTriageStatusId = (
  statusId: string | null | undefined
): boolean => statusId === TRIAGE_STATUS_ID;

/** The status id an issue shows under: Triage while it waits there, else its own. */
export const shownStatusId = (issue: {
  status_id: string;
  in_triage?: boolean | undefined;
}): string =>
  issue.in_triage === true ? TRIAGE_STATUS_ID : issue.status_id;

/** The statuses a picker offers: Triage first when the team has triage on. */
export const withTriage = <T extends StatusRead>(
  statuses: readonly T[],
  triageOn: boolean,
  teamId?: string
): (T | (StatusRead & { team_id?: string }))[] =>
  triageOn ? [triageStatusFor(teamId), ...statuses] : [...statuses];
