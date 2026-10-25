/**
 * Retired teams: kept readable but out of the way. A retired team leaves the
 * sidebar and every team picker, and its pages say it is read-only, while its
 * issues still open and search still finds them.
 */

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
