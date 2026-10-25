/**
 * The quiet line the create issue dialog shows when the new issue will wait in
 * a team's triage inbox and someone is on triage duty there: who is notified,
 * or who it is assigned to in turn. Kept out of the dialog so the wording is
 * tested on its own.
 */

import { personLabel, type Assignable } from './issuePeople';
import type { TriageSettingsRead } from '../types/Api';

/** Joins names the way a sentence lists them: "A", "A and B", "A, B and C". */
const joinNames = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;

/**
 * The line naming who will see a new triage issue, or null when nobody is on
 * duty, triage is off, or an assign team's issue already has an assignee.
 */
export const triageDutyLine = (
  settings: TriageSettingsRead | null | undefined,
  people: readonly Assignable[],
  assigneeId: string | null
): string | null => {
  if (settings === null || settings === undefined || !settings.enabled) {
    return null;
  }
  if (settings.responsibility_action === 'assign' && assigneeId !== null) {
    return null;
  }
  const names = settings.responsible_user_ids
    .map((userId) => people.find((person) => person.user_id === userId))
    .filter((person): person is Assignable => person !== undefined)
    .map((person) => personLabel(person));
  if (names.length === 0) return null;
  if (settings.responsibility_action === 'assign') {
    return names.length === 1
      ? `Triage duty: ${joinNames(names)} will be assigned this issue.`
      : `Triage duty: one of ${joinNames(names)} will be assigned this issue.`;
  }
  return `Triage duty: ${joinNames(names)} will be notified.`;
};
