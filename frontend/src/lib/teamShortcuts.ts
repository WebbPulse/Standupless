/**
 * The Ctrl+Shift+1 to 9 team shortcuts, as in Linear: each digit opens the
 * team in that position of the sidebar's team list.
 */

import type { TeamRead } from '../types/Api';
import { nestTeams } from './teamOrder';
import { activeTeams } from './teamRetirement';

/** How many teams have a shortcut of their own. */
export const TEAM_SHORTCUT_COUNT = 9;

/** The label the help panel lists every team shortcut under. */
export const TEAM_SHORTCUT_LABEL = 'Open team 1 to 9';

/** The registry keys that open the team at a 1-based sidebar position. */
export const teamShortcutKeys = (position: number): string =>
  `ctrl+shift+${String(position)}`;

/** Whether a registry `keys` string is one of the team shortcuts. */
export const isTeamShortcutKeys = (keys: string): boolean =>
  /^ctrl\+shift\+[1-9]$/.test(keys);

type SidebarTeam = Pick<
  TeamRead,
  'id' | 'retired_at' | 'private' | 'is_member' | 'parent_team_id'
>;

/**
 * The teams in the order the sidebar lists them: the saved order the server
 * returns, retired teams and private teams the viewer is not in left out, and
 * each sub-team right after its parent.
 */
export const sidebarTeamOrder = <T extends SidebarTeam>(
  teams: readonly T[]
): T[] =>
  nestTeams(
    activeTeams(teams).filter(
      (team) => team.private !== true || team.is_member === true
    )
  );

/** The team at a 1-based sidebar position, or undefined when there is none. */
export const teamAtPosition = <T extends SidebarTeam>(
  teams: readonly T[],
  position: number
): T | undefined =>
  position < 1 || position > TEAM_SHORTCUT_COUNT
    ? undefined
    : sidebarTeamOrder(teams)[position - 1];
