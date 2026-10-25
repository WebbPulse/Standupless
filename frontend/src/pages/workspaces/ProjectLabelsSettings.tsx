/**
 * The Project labels page of workspace settings: the labels every project in
 * the workspace draws from, as Linear's project labels. Any member reads them
 * with how many projects carry each; a workspace owner or admin adds, renames,
 * recolors and deletes them, and a deleted label leaves every project that
 * carried it. The page also names the teams that keep labels of their own,
 * which their team admins manage in team settings.
 */

import React from 'react';
import ProjectLabelsEditor from '../../components/planning/ProjectLabelsEditor';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeamsFor } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { teamSettingsPath } from '../../lib/paths';

/** Lists and edits the workspace's project labels. */
const ProjectLabelsSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id ?? '';
  const { data: teams } = useTeamsFor(workspaceId);
  const slug = workspace?.slug ?? '';

  return (
    <WorkspaceShell title="Settings">
      <div className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Project labels</h2>
          <p className="text-sm text-text-muted">
            Labels for projects, shared by every team. Set them on a project,
            show them on the projects list and filter by them. Only a workspace
            admin changes them here; a team can add its own in team settings.
          </p>
        </div>
        <ProjectLabelsEditor
          workspaceId={workspaceId}
          teamId={null}
          canEdit={canManageMembers(workspace?.role)}
          teams={teams ?? []}
          teamSettingsPath={(team) => teamSettingsPath(slug, team.key_prefix)}
        />
      </div>
    </WorkspaceShell>
  );
};

export default ProjectLabelsSettings;
