/**
 * Resolves the key prefix in a route to the team it names. The contract has no
 * route that reads a team by key prefix, so every team-scoped page has to
 * resolve it through the workspace's list; this puts that one read in one
 * place so the pages agree on what a missing team looks like.
 */

import type { TeamRead } from '../types/Api';
import { useTeams } from './useTeams';

/** What a team-scoped page needs to render itself. */
export interface UseTeamResult {
  /** The resolved team, or null while loading or when none matches. */
  team: TeamRead | null;
  /** Every team the caller can see, for a picker or a cross-team page. */
  teams: TeamRead[];
  workspaceId: string;
  isLoading: boolean;
  /** True once the list has arrived and holds no team with that prefix. */
  notFound: boolean;
  error: unknown;
}

/** Resolves one team from a key prefix, and hands back the whole list with it. */
export const useTeam = (keyPrefix: string | undefined): UseTeamResult => {
  const { data, error, isLoading, workspaceId } = useTeams();

  const teams = data ?? [];
  const team =
    data === null || keyPrefix === undefined
      ? null
      : (teams.find((row) => row.key_prefix === keyPrefix) ?? null);

  return {
    team,
    teams,
    workspaceId,
    isLoading: isLoading || data === null,
    notFound: data !== null && keyPrefix !== undefined && team === null,
    error,
  };
};

export default useTeam;
