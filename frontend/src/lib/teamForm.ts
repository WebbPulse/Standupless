/**
 * The rules a team's editable fields are held to, mirroring the API's team
 * schema so the create dialog and the team's General settings refuse the same
 * values the server would, before a request is spent.
 */

import type { EstimateScale } from '../types/Api';

/** The estimate scales the contract allows, with their interface wording. */
export const ESTIMATE_SCALES: { value: EstimateScale; label: string }[] = [
  { value: 'off', label: 'No estimates' },
  { value: 'fibonacci', label: 'Fibonacci' },
  { value: 'linear', label: 'Linear' },
  { value: 'tshirt', label: 'T-shirt sizes' },
];

/** The longest team name the API accepts. */
export const TEAM_NAME_MAX = 80;

/** The longest team description the API accepts. */
export const TEAM_DESCRIPTION_MAX = 2000;

/**
 * Checks a team name, answering the sentence to show or null when it passes.
 * Blank answers null so an untouched field does not read as an error.
 */
export const validateTeamName = (value: string): string | null => {
  if (value === '') return null;
  if (value.trim() === '') return 'Give the team a name.';
  if (value.trim().length > TEAM_NAME_MAX) {
    return `Use at most ${String(TEAM_NAME_MAX)} characters.`;
  }
  return null;
};

/** Checks a team description against the API's ceiling. */
export const validateTeamDescription = (value: string): string | null =>
  value.length > TEAM_DESCRIPTION_MAX
    ? `Use at most ${String(TEAM_DESCRIPTION_MAX)} characters.`
    : null;
