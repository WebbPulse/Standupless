/**
 * The lists a team's property pickers choose from, read with the same query
 * keys the rest of the application uses, so a write anywhere that invalidates
 * the statuses or labels refreshes these too. The issue surfaces that are not
 * handed their lists, the peek pane and the new issue dialog after a team
 * switch, read them through here rather than each repeating six queries.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { listIssues } from '../api/issues';
import { listCycles, listProjects } from '../api/planning';
import {
  createLabel as createTeamLabel,
  listLabels,
  listStatuses,
  listTeamMembers,
} from '../api/teams';
import { errorMessage } from '../lib/errors';
import type { Assignable } from '../lib/issuePeople';
import { labelColorFor } from '../lib/propertyOptions';
import {
  cyclesKey,
  labelsKey,
  parentsKey,
  projectsKey,
  statusesKey,
  teamMembersKey,
} from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type {
  CycleRead,
  IssueRead,
  LabelRead,
  ProjectRead,
  StatusRead,
} from '../types/Api';

/** How often the lists are re-read. */
const POLL_MS = 60000;

/** How many candidate parents the parent picker offers. */
export const PARENT_LIMIT = 100;

/** Which of the heavier lists a caller needs. */
export interface TeamOptionsNeeds {
  /** Reads cycles and projects. */
  planning?: boolean;
  /** Reads the candidate parents. */
  parents?: boolean;
}

/** The lists a team's pickers offer, empty until each read lands. */
export interface TeamOptions {
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  cycles: CycleRead[];
  projects: ProjectRead[];
  /** Issues in the team, by key, for the parent picker to narrow. */
  parents: IssueRead[];
  /** Creates a label in the team and refreshes the label list. */
  createLabel: (name: string) => Promise<LabelRead | null>;
}

/**
 * Reads the lists one team's pickers offer. An empty team id reads nothing,
 * so a caller can mount this before it knows the team.
 */
export const useTeamOptions = (
  workspaceId: string,
  teamId: string,
  needs: TeamOptionsNeeds = {}
): TeamOptions => {
  const auth = useQueryAuth();
  const enabled = workspaceId !== '' && teamId !== '';

  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, enabled, queryKey: statusesKey(teamId), auth }
  );

  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, enabled, queryKey: labelsKey(teamId), auth }
  );

  const { data: people } = usePolledQuery(
    ({ signal }) => listTeamMembers(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, enabled, queryKey: teamMembersKey(teamId), auth }
  );

  const { data: cycles } = usePolledQuery(
    ({ signal }) => listCycles(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && needs.planning === true,
      queryKey: cyclesKey(workspaceId, teamId, ''),
      auth,
    }
  );

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && needs.planning === true,
      queryKey: projectsKey(workspaceId, teamId, ''),
      auth,
    }
  );

  const { data: parents } = usePolledQuery(
    ({ signal }) =>
      listIssues(
        workspaceId,
        { team_id: teamId, sort: 'key_asc', limit: PARENT_LIMIT },
        signal
      ),
    {
      intervalMs: POLL_MS,
      enabled: enabled && needs.parents === true,
      queryKey: parentsKey(teamId),
      auth,
    }
  );

  const createLabel = useCallback(
    (name: string): Promise<LabelRead | null> =>
      createTeamLabel(workspaceId, teamId, {
        name,
        color: labelColorFor(name),
      }).then(
        (label) => {
          invalidateQueries(labelsKey(teamId));
          return label;
        },
        (error: unknown) => {
          showErrorToast(errorMessage(error, 'Could not create that label.'));
          return null;
        }
      ),
    [workspaceId, teamId]
  );

  return {
    statuses: statuses ?? [],
    labels: labels ?? [],
    people: people ?? [],
    cycles: cycles?.cycles ?? [],
    projects: projects?.projects ?? [],
    parents: parents?.issues ?? [],
    createLabel,
  };
};
