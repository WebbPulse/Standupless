/**
 * The lists an issue view resolves ids against, for one team or several. A
 * saved view can span every team the caller sees, and its groups, filters
 * and pickers need each team's statuses, labels and people, so every team is
 * read inside each polled query rather than one hook per team, which a
 * changing team count could not call.
 *
 * Every status and label carries the team it came from, so a status column
 * that merges "In Progress" across teams still moves each card to its own
 * team's status.
 *
 * Projects are read once for the whole workspace and split by team, rather
 * than once per team, because the workspace read is the one the other
 * surfaces on the page already make and the shared client hands it over.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { listCycles } from '../api/planning';
import {
  createLabel as createTeamLabel,
  listLabels,
  listStatuses,
  listTeamMembers,
} from '../api/teams';
import { errorMessage } from '../lib/errors';
import type { Assignable } from '../lib/issuePeople';
import type { IssueContext, ScopedLabel, ScopedStatus } from '../lib/issueView';
import { labelColorFor } from '../lib/propertyOptions';
import { withGroupNames } from '../lib/labelGroups';
import { labelsKey } from '../lib/queryKeys';
import { readCachedParts, writeCachedPart } from '../lib/issueContextCache';
import { listAllProjects } from './useWorkspaceProjects';
import { showErrorToast } from '../lib/toast';
import type { CycleRead, LabelRead, ProjectRead } from '../types/Api';

/** How often the lists are re-read. */
const POLL_MS = 60000;

/** A team's statuses and labels, the lists every row paints from. */
interface TeamAppearance {
  teamId: string;
  statuses: ScopedStatus[];
  labels: ScopedLabel[];
}

/** A team's people, projects and cycles, which only pickers and filters need. */
interface TeamPlanning {
  teamId: string;
  people: Assignable[];
  projects: ProjectRead[];
  cycles: CycleRead[];
}

/** Everything read for one team. */
type TeamLists = TeamAppearance & TeamPlanning;

/** What {@link useIssueContext} hands back. */
export interface IssueContextState {
  context: IssueContext;
  /** The lists of one team, for the pickers on that team's issues. */
  forTeam: (teamId: string) => IssueContext;
  /** True until every team's statuses and labels are known, cached or read. */
  isLoading: boolean;
  /** Creates a label in a team and refreshes the lists. */
  createLabel: (teamId: string, name: string) => Promise<LabelRead | null>;
}

/** A settled read, or an empty list when that one read failed. */
const orEmpty = async <T>(read: Promise<T[]>): Promise<T[]> => {
  try {
    return await read;
  } catch {
    return [];
  }
};

/** Reads one team's statuses and labels, keeping the statuses if labels fail. */
const readAppearance = async (
  workspaceId: string,
  teamId: string,
  signal: AbortSignal
): Promise<TeamAppearance> => {
  const [statuses, labels] = await Promise.all([
    listStatuses(workspaceId, teamId, signal),
    orEmpty(listLabels(workspaceId, teamId, signal)),
  ]);
  return {
    teamId,
    statuses: statuses.map((status) => ({ ...status, team_id: teamId })),
    labels: withGroupNames(labels).map((label) => ({
      ...label,
      team_id: teamId,
    })),
  };
};

/**
 * Reads one team's people, projects and cycles, keeping what it can when one
 * of them fails. The team's projects are picked out of the workspace's, read
 * once by the caller.
 */
const readPlanning = async (
  workspaceId: string,
  teamId: string,
  workspaceProjects: Promise<ProjectRead[]>,
  signal: AbortSignal
): Promise<TeamPlanning> => {
  const [people, projects, cycles] = await Promise.all([
    orEmpty(listTeamMembers(workspaceId, teamId, signal)),
    workspaceProjects.then((all) =>
      all.filter(
        (project) =>
          project.team_id === teamId || project.team_ids.includes(teamId)
      )
    ),
    orEmpty(
      listCycles(workspaceId, { team_id: teamId }, signal).then(
        (page) => page.cycles
      )
    ),
  ]);
  return { teamId, people, projects, cycles };
};

/** Pairs each team's appearance with its planning lists, empty until read. */
const combine = (
  appearance: readonly TeamAppearance[],
  planning: readonly TeamPlanning[] | null
): TeamLists[] => {
  const byTeam = new Map(
    (planning ?? []).map((team) => [team.teamId, team] as const)
  );
  return appearance.map((team) => ({
    people: [],
    projects: [],
    cycles: [],
    ...byTeam.get(team.teamId),
    ...team,
  }));
};

/**
 * Writes each team's freshly read part to the browser cache, once per new
 * value of the query rather than on every render.
 */
const useRemember = (
  workspaceId: string,
  part: 'statuses' | 'lists',
  data: readonly { teamId: string }[] | null
): void => {
  useEffect(() => {
    if (data === null || workspaceId === '') return;
    for (const team of data) {
      writeCachedPart(workspaceId, team.teamId, part, team);
    }
  }, [workspaceId, part, data]);
};

/** Joins several teams' lists, each person, project and cycle once. */
const merge = (
  teams: TeamLists[],
  currentUserId: string | undefined
): IssueContext => {
  const once = <T>(items: T[], id: (item: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = id(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    statuses: teams.flatMap((team) => team.statuses),
    labels: teams.flatMap((team) => team.labels),
    people: once(
      teams.flatMap((team) => team.people),
      (person) => person.user_id
    ),
    projects: once(
      teams.flatMap((team) => team.projects),
      (project) => project.project_id
    ),
    cycles: once(
      teams.flatMap((team) => team.cycles),
      (cycle) => cycle.cycle_id
    ),
    ...(currentUserId === undefined ? {} : { currentUserId }),
  };
};

/**
 * Reads the lists for the given teams. Statuses and labels are one query and
 * people, projects and cycles another, so the rows' appearance never waits on
 * the slower planning reads. Both seed from the browser cache, so a reload
 * paints the last known lists and the polls refresh them in place.
 */
export const useIssueContext = (
  workspaceId: string,
  teamIds: readonly string[],
  currentUserId?: string
): IssueContextState => {
  const auth = useQueryAuth();
  const ids = useMemo(() => [...new Set(teamIds)].sort(), [teamIds]);
  const idsJson = ids.join(',');
  const enabled = workspaceId !== '' && idsJson !== '';
  const appearanceKey = useMemo(
    () => ['issue-appearance', workspaceId, idsJson] as const,
    [workspaceId, idsJson]
  );
  const queryKey = useMemo(
    () => ['issue-context', workspaceId, idsJson] as const,
    [workspaceId, idsJson]
  );
  const teamList = useMemo(
    (): string[] => (idsJson === '' ? [] : idsJson.split(',')),
    [idsJson]
  );

  const cachedAppearance = useMemo(
    () => readCachedParts<TeamAppearance>(workspaceId, teamList, 'statuses'),
    [workspaceId, teamList]
  );
  const cachedPlanning = useMemo(
    () => readCachedParts<TeamPlanning>(workspaceId, teamList, 'lists'),
    [workspaceId, teamList]
  );

  const appearance = usePolledQuery(
    ({ signal }) =>
      Promise.all(
        teamList.map((teamId) => readAppearance(workspaceId, teamId, signal))
      ),
    { intervalMs: POLL_MS, enabled, queryKey: appearanceKey, auth }
  );

  const planning = usePolledQuery(
    ({ signal }) => {
      const projects = orEmpty(listAllProjects(workspaceId, '', signal));
      return Promise.all(
        teamList.map((teamId) =>
          readPlanning(workspaceId, teamId, projects, signal)
        )
      );
    },
    { intervalMs: POLL_MS, enabled, queryKey, auth }
  );

  useRemember(workspaceId, 'statuses', appearance.data);
  useRemember(workspaceId, 'lists', planning.data);

  const data = useMemo(() => {
    const shown = appearance.data ?? cachedAppearance;
    return shown === null
      ? null
      : combine(shown, planning.data ?? cachedPlanning);
  }, [appearance.data, cachedAppearance, planning.data, cachedPlanning]);

  const context = useMemo(
    () => merge(data ?? [], currentUserId),
    [data, currentUserId]
  );

  const perTeam = useMemo(
    () =>
      new Map(
        (data ?? []).map((team) => [team.teamId, merge([team], currentUserId)])
      ),
    [data, currentUserId]
  );

  const forTeam = useCallback(
    (teamId: string): IssueContext =>
      perTeam.get(teamId) ?? merge([], currentUserId),
    [perTeam, currentUserId]
  );

  const createLabel = useCallback(
    (teamId: string, name: string): Promise<LabelRead | null> =>
      createTeamLabel(workspaceId, teamId, {
        name,
        color: labelColorFor(name),
      }).then(
        (label) => {
          invalidateQueries([appearanceKey, queryKey, labelsKey(teamId)]);
          return label;
        },
        (error: unknown) => {
          showErrorToast(errorMessage(error, 'Could not create that label.'));
          return null;
        }
      ),
    [workspaceId, appearanceKey, queryKey]
  );

  return {
    context,
    forTeam,
    isLoading: enabled && appearance.isLoading && cachedAppearance === null,
    createLabel,
  };
};

export default useIssueContext;
