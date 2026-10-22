/**
 * The workspace-wide create project and create initiative dialogs, rendered
 * by the workspace layout so the command palette can open either over any
 * page. A new project starts on the team the route is inside when the caller
 * can write there, and a new initiative is owned by its creator, the same
 * presets the Projects and Initiatives pages use. Either one opens on creation.
 */

import React from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { useNavigate } from 'react-router-dom';
import useWorkspaceMembers from '../../hooks/useWorkspaceMembers';
import { initiativePath, projectPath } from '../../lib/paths';
import { initiativesKey, projectsKey } from '../../lib/queryKeys';
import type { TeamRead } from '../../types/Api';
import CreateInitiativeDialog from './CreateInitiativeDialog';
import CreateProjectDialog from './CreateProjectDialog';

/** Which dialog is open, if any. */
export type PlanningDialog = 'project' | 'initiative' | null;

/** Props for CreatePlanningHost. */
export interface CreatePlanningHostProps {
  open: PlanningDialog;
  workspaceId: string;
  slug: string;
  /** The teams the caller can write issues in. */
  writableTeams: readonly TeamRead[];
  /** The key prefix of the team the route is inside, or null. */
  routePrefix: string | null;
  /** The signed in person, who owns a new initiative. */
  currentUserId: string | undefined;
  onClose: () => void;
}

/** Props for the create initiative host. */
interface InitiativeHostProps {
  workspaceId: string;
  currentUserId: string | undefined;
  onClose: () => void;
  onCreated: (initiativeId: string) => void;
}

/** The create initiative dialog, with the workspace members read for its owner picker. */
const InitiativeHost: React.FC<InitiativeHostProps> = ({
  workspaceId,
  currentUserId,
  onClose,
  onCreated,
}) => {
  const members = useWorkspaceMembers(workspaceId);
  return (
    <CreateInitiativeDialog
      workspaceId={workspaceId}
      people={members}
      initialOwnerId={currentUserId ?? null}
      onClose={onClose}
      onCreated={(initiative) => {
        onCreated(initiative.initiative_id);
      }}
    />
  );
};

/** Renders whichever planning dialog is open. */
export const CreatePlanningHost: React.FC<CreatePlanningHostProps> = ({
  open,
  workspaceId,
  slug,
  writableTeams,
  routePrefix,
  currentUserId,
  onClose,
}) => {
  const navigate = useNavigate();
  if (workspaceId === '' || open === null) return null;

  if (open === 'initiative') {
    return (
      <InitiativeHost
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        onClose={onClose}
        onCreated={(initiativeId) => {
          onClose();
          invalidateQueries(initiativesKey(workspaceId, ''));
          void navigate(initiativePath(slug, initiativeId));
        }}
      />
    );
  }

  const start =
    writableTeams.find((team) => team.key_prefix === routePrefix) ??
    writableTeams[0];
  if (start === undefined) return null;

  return (
    <CreateProjectDialog
      workspaceId={workspaceId}
      teams={[...writableTeams]}
      initialTeamIds={[start.id]}
      onClose={onClose}
      onCreated={(project) => {
        onClose();
        invalidateQueries(projectsKey(workspaceId, '', ''));
        void navigate(projectPath(slug, project.project_id));
      }}
    />
  );
};

export default CreatePlanningHost;
