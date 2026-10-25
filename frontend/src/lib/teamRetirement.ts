/**
 * Retired teams: kept readable but out of the way. A retired team leaves the
 * sidebar and every team picker, and its pages say it is read-only, while its
 * issues still open and search still finds them.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';
import type { TeamRead } from '../types/Api';

/** Whether a team is retired. */
export const isRetired = (team: Pick<TeamRead, 'retired_at'>): boolean =>
  team.retired_at !== undefined && team.retired_at !== null;

/** The teams that are not retired, in the order given. */
export const activeTeams = <T extends Pick<TeamRead, 'retired_at'>>(
  teams: readonly T[]
): T[] => teams.filter((team) => !isRetired(team));

/** The retired teams, in the order given. */
export const retiredTeams = <T extends Pick<TeamRead, 'retired_at'>>(
  teams: readonly T[]
): T[] => teams.filter(isRetired);

/**
 * The teams a team filter offers: every active team, plus any retired team
 * the filter already names so an explicit choice stays visible and editable.
 */
export const teamFilterTeams = <T extends Pick<TeamRead, 'id' | 'retired_at'>>(
  teams: readonly T[],
  named: ReadonlySet<string>
): T[] => teams.filter((team) => !isRetired(team) || named.has(team.id));

/** The code the retire route answers while a team still has open issues. */
export const TEAM_HAS_OPEN_ISSUES = 'TEAM_HAS_OPEN_ISSUES';

/**
 * How many open issues held a retire back, read from the refusal's details,
 * or null when the failure was anything else.
 */
export const openIssueCount = (error: unknown): number | null => {
  if (!(error instanceof ApiError)) return null;
  const { errorCode, details } = getWebbPulseError(error);
  if (errorCode !== TEAM_HAS_OPEN_ISSUES || Array.isArray(details)) {
    return null;
  }
  const count = details?.['open_issue_count'];
  return typeof count === 'number' ? count : null;
};
