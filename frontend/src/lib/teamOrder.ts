/**
 * Pure helpers for the caller's own sidebar team order: moving one team to a
 * new place, and laying a pending order over the list the server last answered
 * while the save is in flight.
 */

/**
 * The ids with the one at `from` moved to `to`. Answers null when the move
 * would change nothing or either index is out of range.
 */
export const moveTeam = (
  ids: string[],
  from: number,
  to: number
): string[] | null => {
  if (from === to || from < 0 || to < 0) return null;
  if (from >= ids.length || to >= ids.length) return null;
  const next = [...ids];
  const [moving] = next.splice(from, 1);
  if (moving === undefined) return null;
  next.splice(to, 0, moving);
  return next;
};

/**
 * The teams sorted by `order`, with any team it does not name after the
 * named ones in their existing order, and any id naming no team ignored. This
 * is the same rule the server applies, so the optimistic list and the saved
 * one agree.
 */
export const applyTeamOrder = <T extends { id: string }>(
  teams: T[],
  order: string[] | null
): T[] => {
  if (order === null) return teams;
  const rank = new Map(order.map((id, index) => [id, index]));
  const last = rank.size;
  return teams
    .map((team, index) => ({ team, index }))
    .sort(
      (left, right) =>
        (rank.get(left.team.id) ?? last) - (rank.get(right.team.id) ?? last) ||
        left.index - right.index
    )
    .map(({ team }) => team);
};
