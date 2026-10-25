/**
 * The CSV rows the Teams and API keys settings lists export, built from the
 * list data the page already holds. A key row names its creator by display
 * name only and never carries an email, a secret or a prefix.
 */

import type { ApiKeyRead, MemberRead, TeamRead } from '../types/Api';

/** An ISO timestamp as `YYYY-MM-DD`, or an empty cell when absent. */
const day = (value: string | null | undefined): string =>
  value === null || value === undefined ? '' : value.slice(0, 10);

/** One row per team, active and retired, with its parent's key. */
export const teamCsvRows = (teams: readonly TeamRead[]): string[][] => {
  const keys = new Map(teams.map((team) => [team.id, team.key_prefix]));
  return [
    [
      'Name',
      'Key',
      'Parent team key',
      'Visibility',
      'Members',
      'Created',
      'Retired',
    ],
    ...teams.map((team) => [
      team.name,
      team.key_prefix,
      team.parent_team_id === null || team.parent_team_id === undefined
        ? ''
        : (keys.get(team.parent_team_id) ?? ''),
      team.private === true ? 'Private' : 'Public',
      team.member_count === undefined ? '' : String(team.member_count),
      day(team.created_at),
      day(team.retired_at),
    ]),
  ];
};

/** A member's written or display name, never their email. */
const creatorName = (member: MemberRead | undefined): string => {
  if (member === undefined) return 'Unknown';
  if (member.full_name !== undefined && member.full_name !== '') {
    return member.full_name;
  }
  return member.display_name ?? 'Unknown';
};

/** One row per API key, its creator resolved against the member list. */
export const apiKeyCsvRows = (
  keys: readonly ApiKeyRead[],
  members: readonly MemberRead[]
): string[][] => {
  const byId = new Map(members.map((member) => [member.user_id, member]));
  return [
    ['Label', 'Created by', 'Scopes', 'Created', 'Last used', 'Expires'],
    ...keys.map((key) => [
      key.name,
      creatorName(byId.get(key.created_by)),
      key.scopes.join('; '),
      day(key.created_at),
      day(key.last_used_at),
      day(key.expires_at),
    ]),
  ];
};
