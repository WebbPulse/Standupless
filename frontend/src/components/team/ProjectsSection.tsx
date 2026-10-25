/**
 * The project labels and project statuses one team keeps for its own
 * projects, beside the workspace's, which every project is offered and only
 * workspace settings change. Linear keeps a team's project labels and
 * statuses in team settings the same way.
 */

import React from 'react';
import ProjectLabelsEditor from '../planning/ProjectLabelsEditor';
import ProjectStatusesEditor from '../planning/ProjectStatusesEditor';

/** Props for ProjectsSection: which team, and whether the caller may edit it. */
export interface ProjectsSectionProps {
  workspaceId: string;
  teamId: string;
  canEdit: boolean;
}

/** Lists and edits a team's own project labels and project statuses. */
const ProjectsSection: React.FC<ProjectsSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => (
  <section aria-labelledby="team-projects-heading" className="space-y-6">
    <div className="space-y-1">
      <h3 id="team-projects-heading" className="text-base font-semibold">
        Projects
      </h3>
      <p className="text-sm text-text-muted">
        Labels and statuses offered only to this team&apos;s projects, alongside
        the workspace&apos;s own.
      </p>
    </div>
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-text">Project labels</h4>
      <ProjectLabelsEditor
        workspaceId={workspaceId}
        teamId={teamId}
        canEdit={canEdit}
      />
    </div>
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-text">Project statuses</h4>
      <ProjectStatusesEditor
        workspaceId={workspaceId}
        teamId={teamId}
        canEdit={canEdit}
      />
    </div>
  </section>
);

export default ProjectsSection;
