/**
 * The workspace security settings page. Only an owner or admin may change the
 * authentication policy, the same as the server allows, so anyone else is told
 * so rather than shown a switch that would answer 403.
 */

import React from 'react';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceSecuritySection from '../../components/workspace/WorkspaceSecuritySection';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';

/** Renders the workspace authentication policy for an admin. */
const SecuritySettings: React.FC = () => {
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
            <WorkspaceSecuritySection workspace={workspace} />
          ) : (
            <p className="text-sm text-text-muted">
              Only workspace owners and admins can change security settings.
            </p>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
};

export default SecuritySettings;
