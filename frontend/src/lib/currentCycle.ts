/**
 * Finding a team's running or next upcoming cycle. The cycle list filters on
 * status after each page is read, so a page can come back empty while the
 * cursor still names more, and the search follows the cursor until a cycle in
 * the wanted state turns up. Pages come in start date order, so the first
 * match is the earliest.
 */

import { listCycles } from '../api/planning';
import { errorMessage } from './errors';
import { cyclePath } from './paths';
import { showErrorToast, showToast } from './toast';
import type { CycleListRead, CycleRead, CycleStatus } from '../types/Api';

/** How many cycles one page of the search asks for, the most the route allows. */
const PAGE_SIZE = 100;

/**
 * The team's earliest started cycle in the given state, or null when it has
 * none. Stops on a repeated cursor rather than looping on it.
 */
const findCycle = async (
  workspaceId: string,
  teamId: string,
  status: CycleStatus,
  signal?: AbortSignal
): Promise<CycleRead | null> => {
  let cursor: string | null = null;
  do {
    const page: CycleListRead = await listCycles(
      workspaceId,
      {
        team_id: teamId,
        status,
        limit: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
      signal
    );
    const found = page.cycles.find((cycle) => cycle.status === status);
    if (found !== undefined) return found;
    if (page.next_cursor !== null && page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  } while (cursor !== null);
  return null;
};

/** The team's running cycle, the earliest started when more than one runs, or null when none does. */
export const findActiveCycle = (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<CycleRead | null> =>
  findCycle(workspaceId, teamId, 'active', signal);

/** The team's next cycle to start, or null when none is scheduled. */
export const findUpcomingCycle = (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<CycleRead | null> =>
  findCycle(workspaceId, teamId, 'upcoming', signal);

/** What {@link openUpcomingCycle} needs to find and open a team's next cycle. */
export interface OpenUpcomingCycle {
  workspaceId: string;
  slug: string;
  team: { id: string; name: string; key_prefix: string };
  navigate: (to: string) => void;
}

/**
 * Opens the team's next upcoming cycle, as `G` then `W` does in Linear. A team
 * with none scheduled, or a failed read, shows a toast and stays on the page.
 */
export const openUpcomingCycle = async ({
  workspaceId,
  slug,
  team,
  navigate,
}: OpenUpcomingCycle): Promise<void> => {
  let cycle: CycleRead | null;
  try {
    cycle = await findUpcomingCycle(workspaceId, team.id);
  } catch (failure: unknown) {
    showErrorToast(errorMessage(failure, 'Could not find the upcoming cycle.'));
    return;
  }
  if (cycle === null) {
    showToast(`${team.name} has no upcoming cycle.`);
    return;
  }
  navigate(cyclePath(slug, team.key_prefix, cycle.cycle_id));
};
