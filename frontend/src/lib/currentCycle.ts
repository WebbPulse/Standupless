/**
 * Finding a team's running cycle. The cycle list filters on status after each
 * page is read, so a page can come back empty while the cursor still names
 * more, and the search follows the cursor until a running cycle turns up.
 */

import { listCycles } from '../api/planning';
import type { CycleListRead, CycleRead } from '../types/Api';

/** How many cycles one page of the search asks for, the most the route allows. */
const PAGE_SIZE = 100;

/**
 * The team's running cycle, the earliest started when more than one runs, or
 * null when none does. Stops on a repeated cursor rather than looping on it.
 */
export const findActiveCycle = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<CycleRead | null> => {
  let cursor: string | null = null;
  do {
    const page: CycleListRead = await listCycles(
      workspaceId,
      {
        team_id: teamId,
        status: 'active',
        limit: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
      signal
    );
    const running = page.cycles.find((cycle) => cycle.status === 'active');
    if (running !== undefined) return running;
    if (page.next_cursor !== null && page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  } while (cursor !== null);
  return null;
};
