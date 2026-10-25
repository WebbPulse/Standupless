/**
 * The Project statuses page of workspace settings: the workspace's own project
 * stages, each inside one of the six fixed categories that progress, rollups
 * and closing key off. Any member reads them with how many projects sit in
 * each; a workspace owner or admin adds, renames, recolors, reorders and
 * deletes them. A deleted status moves its projects onto another status in the
 * same category, and every category keeps at least one. The first status of a
 * category is its default, where a project set to only the category lands. The
 * statuses a team keeps for its own projects show beside them, marked with the
 * team, and are changed in that team's settings.
 */

import React from 'react';
import ProjectStatusesEditor from '../../components/planning/ProjectStatusesEditor';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeamsFor } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';

/** Lists and edits the workspace's project statuses, grouped by category. */
const ProjectStatusesSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id ?? '';
  const { data: teams } = useTeamsFor(workspaceId);

  return (
    <WorkspaceShell title="Settings">
      <div className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Project statuses</h2>
          <p className="text-sm text-text-muted">
            The stages a project moves through, shared by every team. Each
            status sits in a fixed category, which decides whether a project
            counts as active or closed. The first status in a category is its
            default. Only a workspace admin changes them here; a team can add
            its own in team settings.
          </p>
        </div>
        <ProjectStatusesEditor
          workspaceId={workspaceId}
          teamId={null}
          canEdit={canManageMembers(workspace?.role)}
          teams={teams ?? []}
        />
      </div>
    </WorkspaceShell>
  );
};

export default ProjectStatusesSettings;
