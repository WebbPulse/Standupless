/**
 * The workspace issue import settings page. Only an owner or admin may import,
 * the same as the server allows, so anyone else is told so rather than shown
 * a form that would answer 403.
 */

import React from 'react';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceImportSection from '../../components/workspace/WorkspaceImportSection';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';

/** Renders the CSV issue import for an admin. */
const ImportSettings: React.FC = () => {
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
            <WorkspaceImportSection workspace={workspace} />
          ) : (
            <p className="text-sm text-text-muted">
              Only workspace owners and admins can import issues.
            </p>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
};

export default ImportSettings;
