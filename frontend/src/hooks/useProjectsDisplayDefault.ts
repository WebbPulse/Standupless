/**
 * The projects page arrangement an admin set for everyone: the team's on a
 * team page, else the workspace's. It answers what a person who never
 * arranged the page opens with, and, for an admin of that scope, how to save
 * the current arrangement as the default for everyone or clear it. A saved
 * view reads neither, since a view carries its own arrangement.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  getDisplayDefaults,
  getWorkspaceDisplayDefaults,
  updateDisplayDefaults,
  updateWorkspaceDisplayDefaults,
} from '../api/teams';
import { canEditWorkspace, isTeamAdmin } from '../lib/capabilities';
import { LOOKUP_POLL_MS } from '../lib/polling';
import {
  DEFAULT_PROJECTS_DISPLAY,
  PROJECTS_DISPLAY_FIELDS,
  resolveDisplay,
  type ProjectsDisplay,
} from '../lib/projectList';
import { showErrorToast, showToast } from '../lib/toast';
import type { TeamRead, WorkspaceRole } from '../types/Api';

/** What the Display panel offers an admin for the default for everyone. */
export interface ProjectsDefaultActions {
  /** Whose default it is, named in the panel. */
  scope: 'team' | 'workspace';
  /** Saves the current arrangement as the default, undefined when it already is. */
  onSave?: (() => void) | undefined;
  /** Drops the default, undefined when none is set. */
  onClear?: (() => void) | undefined;
  /** True while a save or clear is in flight. */
  busy: boolean;
}

/** What useProjectsDisplayDefault answers. */
export interface ProjectsDisplayDefault {
  /** What a person who never arranged the page opens with. */
  fallback: ProjectsDisplay;
  /** Saves `display` as the default, or clears it; undefined for a non-admin. */
  actionsFor: (display: ProjectsDisplay) => ProjectsDefaultActions | undefined;
}

/** Options for useProjectsDisplayDefault. */
export interface ProjectsDisplayDefaultOptions {
  workspaceId: string;
  workspaceRole: WorkspaceRole | undefined;
  /** The team the page is filtered to, undefined on the workspace page. */
  team: TeamRead | undefined;
  /** True on the workspace page, false while a team filter waits on its team. */
  workspacePage: boolean;
  /** False on a saved view, which reads no default. */
  enabled: boolean;
}

/** Whether two arrangements hold the same choice in every field. */
const sameDisplay = (left: ProjectsDisplay, right: ProjectsDisplay): boolean =>
  PROJECTS_DISPLAY_FIELDS.every((field) => left[field] === right[field]);

/** Reads the default for everyone on the projects page and how an admin changes it. */
export const useProjectsDisplayDefault = ({
  workspaceId,
  workspaceRole,
  team,
  workspacePage,
  enabled,
}: ProjectsDisplayDefaultOptions): ProjectsDisplayDefault => {
  const auth = useQueryAuth();
  const teamId = team?.id ?? '';
  const teamDefaults = usePolledQuery(
    ({ signal }) => getDisplayDefaults(workspaceId, teamId, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: enabled && workspaceId !== '' && teamId !== '',
      queryKey: ['team-display-defaults', workspaceId, teamId],
      auth,
    }
  );
  const workspaceDefaults = usePolledQuery(
    ({ signal }) => getWorkspaceDisplayDefaults(workspaceId, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: enabled && workspaceId !== '' && workspacePage,
      queryKey: ['workspace-display-defaults', workspaceId],
      auth,
    }
  );
  const onTeam = team !== undefined;
  const answer = onTeam
    ? teamDefaults.data
    : workspacePage
      ? workspaceDefaults.data
      : undefined;
  const effective = enabled ? answer?.effective_projects_display : undefined;
  const fallback = useMemo(
    () =>
      effective === undefined
        ? DEFAULT_PROJECTS_DISPLAY
        : resolveDisplay(() => null, effective),
    [effective]
  );
  const isSet =
    answer?.projects_display !== null && answer?.projects_display !== undefined;
  const admin =
    enabled &&
    (team !== undefined
      ? isTeamAdmin(workspaceRole, team.role)
      : workspacePage && canEditWorkspace(workspaceRole));
  const [busy, setBusy] = useState(false);
  const refetchTeam = teamDefaults.refetch;
  const refetchWorkspace = workspaceDefaults.refetch;

  const write = useCallback(
    (next: ProjectsDisplay | null): void => {
      setBusy(true);
      const request = onTeam
        ? updateDisplayDefaults(workspaceId, teamId, {
            projects_display: next,
          }).then(() => refetchTeam())
        : updateWorkspaceDisplayDefaults(workspaceId, next).then(() =>
            refetchWorkspace()
          );
      void request
        .then(() => {
          showToast(
            next === null
              ? 'Default cleared.'
              : 'Saved as the default for everyone.'
          );
        })
        .catch(() => {
          showErrorToast(
            next === null
              ? 'Could not clear the default for everyone.'
              : 'Could not save the default for everyone.'
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [onTeam, workspaceId, teamId, refetchTeam, refetchWorkspace]
  );

  const actionsFor = useCallback(
    (display: ProjectsDisplay): ProjectsDefaultActions | undefined =>
      admin
        ? {
            scope: onTeam ? 'team' : 'workspace',
            onSave:
              isSet && sameDisplay(display, fallback)
                ? undefined
                : () => {
                    write(display);
                  },
            onClear: isSet
              ? () => {
                  write(null);
                }
              : undefined,
            busy,
          }
        : undefined,
    [admin, onTeam, isSet, fallback, write, busy]
  );

  return { fallback, actionsFor };
};

export default useProjectsDisplayDefault;
