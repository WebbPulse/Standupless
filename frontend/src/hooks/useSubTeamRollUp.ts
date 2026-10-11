/**
 * Whether a parent team's page rolls up the sub-teams the caller can see, as
 * Linear does. Rolling up is the default; turning it off is kept in the URL
 * as `subteams=0`, so a link to the narrower page stays narrow. A team with
 * no visible sub-teams never rolls up, so its pages read exactly as before.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TeamRead } from '../types/Api';
import { useTeams } from './useTeams';

/** The URL parameter that turns the sub-team roll-up off. */
export const ROLL_UP_PARAM = 'subteams';

/** What {@link useSubTeamRollUp} hands back. */
export interface SubTeamRollUp {
  /** The team's direct sub-teams the caller can see. */
  subTeams: TeamRead[];
  /** True when the page includes the sub-teams. */
  rollUp: boolean;
  /** Switches between including the sub-teams and the team alone. */
  toggle: () => void;
}

/**
 * The roll-up state of `team`'s page. `enabled` false keeps the page on the
 * team alone, as the archive does, while still listing the sub-teams.
 */
export const useSubTeamRollUp = (
  team: TeamRead | null | undefined,
  enabled = true
): SubTeamRollUp => {
  const { data: allTeams } = useTeams();
  const [params, setParams] = useSearchParams();
  const teamId = team?.id;
  const subTeams = useMemo(
    () =>
      teamId === undefined
        ? []
        : (allTeams ?? []).filter((other) => other.parent_team_id === teamId),
    [allTeams, teamId]
  );
  const rollUp =
    enabled && subTeams.length > 0 && params.get(ROLL_UP_PARAM) !== '0';
  const toggle = useCallback((): void => {
    const next = new URLSearchParams(params);
    if (rollUp) next.set(ROLL_UP_PARAM, '0');
    else next.delete(ROLL_UP_PARAM);
    setParams(next, { replace: true });
  }, [params, rollUp, setParams]);
  return { subTeams, rollUp, toggle };
};

export default useSubTeamRollUp;
