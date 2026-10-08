/**
 * The workspace export settings page. Only an owner or admin may export, the
 * same as the server allows, so anyone else is told so rather than shown a
 * button that would answer 403.
 */

import React from 'react';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceExportSection from '../../components/workspace/WorkspaceExportSection';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';

/** Renders the export of the whole workspace for an admin. */
const ExportSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      {workspace !== null && (
        <div className="max-w-2xl space-y-8">
          {canManageMembers(workspace.role) ? (
            <WorkspaceExportSection workspace={workspace} />
          ) : (
            <p className="text-sm text-text-muted">
              Only workspace owners and admins can export the workspace.
            </p>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
};

export default ExportSettings;
