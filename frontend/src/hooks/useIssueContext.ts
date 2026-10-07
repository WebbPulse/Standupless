/**
 * The lists an issue view resolves ids against, for one team or several. A
 * saved view can span every team the caller sees, and its groups, filters
 * and pickers need each team's statuses, labels and people, so they are read
 * in one polled query rather than one hook per team, which a changing team
 * count could not call.
 *
 * Every status and label carries the team it came from, so a status column
 * that merges "In Progress" across teams still moves each card to its own
 * team's status.
 *
 * Projects are read once for the whole workspace and split by team, rather
 * than once per team, because the workspace read is the one the other
 * surfaces on the page already make and the shared client hands it over.
 */

import { useCallback, useMemo } from 'react';
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
import { listAllProjects } from './useWorkspaceProjects';
import { showErrorToast } from '../lib/toast';
import type { CycleRead, LabelRead, ProjectRead } from '../types/Api';

/** How often the lists are re-read. */
const POLL_MS = 60000;

/** Everything read for one team. */
interface TeamLists {
  teamId: string;
  statuses: ScopedStatus[];
  labels: ScopedLabel[];
  people: Assignable[];
  projects: ProjectRead[];
  cycles: CycleRead[];
}

/** What {@link useIssueContext} hands back. */
export interface IssueContextState {
  context: IssueContext;
  /** The lists of one team, for the pickers on that team's issues. */
  forTeam: (teamId: string) => IssueContext;
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

/**
 * Reads one team's lists, keeping what it can when one of them fails. The
 * team's projects are picked out of the workspace's, read once by the caller.
 */
const readTeam = async (
  workspaceId: string,
  teamId: string,
  workspaceProjects: Promise<ProjectRead[]>,
  signal: AbortSignal
): Promise<TeamLists> => {
  const [statuses, labels, people, projects, cycles] = await Promise.all([
    listStatuses(workspaceId, teamId, signal),
    orEmpty(listLabels(workspaceId, teamId, signal)),
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
  return {
    teamId,
    statuses: statuses.map((status) => ({ ...status, team_id: teamId })),
    labels: withGroupNames(labels).map((label) => ({
      ...label,
      team_id: teamId,
    })),
    people,
    projects,
    cycles,
  };
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

/** Reads the lists for the given teams. */
export const useIssueContext = (
  workspaceId: string,
  teamIds: readonly string[],
  currentUserId?: string
): IssueContextState => {
  const auth = useQueryAuth();
  const ids = useMemo(() => [...new Set(teamIds)].sort(), [teamIds]);
  const idsJson = ids.join(',');
  const queryKey = useMemo(
    () => ['issue-context', workspaceId, idsJson] as const,
    [workspaceId, idsJson]
  );

  const { data, isLoading } = usePolledQuery(
    ({ signal }) => {
      const projects = orEmpty(listAllProjects(workspaceId, '', signal));
      return Promise.all(
        (idsJson === '' ? [] : idsJson.split(',')).map((teamId) =>
          readTeam(workspaceId, teamId, projects, signal)
        )
      );
    },
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && idsJson !== '',
      queryKey,
      auth,
    }
  );

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
          invalidateQueries([queryKey, labelsKey(teamId)]);
          return label;
        },
        (error: unknown) => {
          showErrorToast(errorMessage(error, 'Could not create that label.'));
          return null;
        }
      ),
    [workspaceId, queryKey]
  );

  return {
    context,
    forTeam,
    isLoading: isLoading && idsJson !== '',
    createLabel,
  };
};

export default useIssueContext;
