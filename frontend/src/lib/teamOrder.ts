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

type Nestable = { id: string; parent_team_id?: string | null };

/** Whether the team sits under a parent that is also in `teams`. */
export const isNested = <T extends Nestable>(
  team: T,
  teams: readonly T[]
): boolean =>
  typeof team.parent_team_id === 'string' &&
  teams.some((other) => other.id === team.parent_team_id);

/** The parent a team is drawn under in `teams`, or null at the top level. */
const levelOf = <T extends Nestable>(
  team: T,
  teams: readonly T[]
): string | null =>
  isNested(team, teams) ? (team.parent_team_id ?? null) : null;

/** Whether two rows of `teams` sit at the same level under the same parent, so one may take the other's place. */
export const areSiblings = <T extends Nestable>(
  teams: readonly T[],
  first: number,
  second: number
): boolean => {
  const left = teams[first];
  const right = teams[second];
  if (left === undefined || right === undefined) return false;
  return levelOf(left, teams) === levelOf(right, teams);
};

/**
 * The index of the nearest row above (`step` -1) or below (`step` 1) that is a
 * sibling of the row at `index`, or null when it is first or last among them.
 * A move steps over a team's sub-teams, which travel with it.
 */
export const siblingIndex = <T extends Nestable>(
  teams: readonly T[],
  index: number,
  step: 1 | -1
): number | null => {
  for (let at = index + step; at >= 0 && at < teams.length; at += step) {
    if (areSiblings(teams, index, at)) return at;
  }
  return null;
};

/**
 * The teams with each sub-team moved to just after its parent, keeping their
 * order otherwise, so the sidebar can nest them. A sub-team whose parent is not
 * in the list stays where it is, at the top level.
 */
export const nestTeams = <T extends Nestable>(teams: readonly T[]): T[] => {
  const children = new Map<string, T[]>();
  const top: T[] = [];
  for (const team of teams) {
    const parent = team.parent_team_id;
    if (typeof parent === 'string' && isNested(team, teams)) {
      children.set(parent, [...(children.get(parent) ?? []), team]);
    } else {
      top.push(team);
    }
  }
  return top.flatMap((team) => [team, ...(children.get(team.id) ?? [])]);
};

/** One team in tree order, with the parent it is drawn under when that parent is listed too. */
export interface TeamTreeRow<T> {
  team: T;
  nested: boolean;
  parentName?: string;
}

/**
 * The teams in tree order for a picker: each sub-team right after its parent,
 * marked nested and carrying the parent's name so filtering by the parent
 * still finds it.
 */
export const teamTree = <T extends Nestable & { name: string }>(
  teams: readonly T[]
): TeamTreeRow<T>[] => {
  const byId = new Map(teams.map((team) => [team.id, team]));
  return nestTeams(teams).map((team) => {
    const parent =
      typeof team.parent_team_id === 'string'
        ? byId.get(team.parent_team_id)
        : undefined;
    return parent === undefined
      ? { team, nested: false }
      : { team, nested: true, parentName: parent.name };
  });
};
