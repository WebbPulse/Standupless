/**
 * Which project labels and project statuses a project is offered. An entry
 * with no team belongs to the workspace and every project is offered it; one
 * with a team is offered only to the projects on that team, as Linear keeps a
 * team's own project labels and statuses beside the workspace's.
 */

/** A project label or status, owned by a team or by the workspace. */
export interface ScopedEntry {
  team_id?: string | null;
}

/** Whether an entry belongs to the workspace rather than to one team. */
export const isWorkspaceEntry = (entry: ScopedEntry): boolean =>
  (entry.team_id ?? null) === null;

/** The workspace's entries together with those of the given teams. */
export const offeredToTeams = <T extends ScopedEntry>(
  entries: readonly T[],
  teamIds: readonly string[]
): T[] => {
  const teams = new Set(teamIds);
  return entries.filter(
    (entry) => isWorkspaceEntry(entry) || teams.has(entry.team_id ?? '')
  );
};

/** How many entries each team keeps of its own, by team id. */
export const teamEntryCounts = (
  entries: readonly ScopedEntry[]
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const team = entry.team_id ?? null;
    if (team !== null) counts.set(team, (counts.get(team) ?? 0) + 1);
  }
  return counts;
};

/**
 * Whether a project on the given teams may take an entry; one not yet read is
 * left for the server to judge.
 */
export const isOfferedTo = (
  entry: ScopedEntry | undefined,
  teamIds: readonly string[]
): boolean =>
  entry === undefined ||
  isWorkspaceEntry(entry) ||
  teamIds.includes(entry.team_id ?? '');
