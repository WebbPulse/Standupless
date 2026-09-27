/**
 * The connected apps settings page. Any member reaches it, because the grants
 * they made are theirs to see and end. The workspace-wide list is added for an
 * admin only, which is what the server allows.
 */

import React from 'react';
import {
  MyConnectedAppsSection,
  WorkspaceConnectedAppsSection,
} from '../../components/access/ConnectedAppsSection';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';

/** Renders the caller's connected apps, and every member's for an admin. */
const ConnectedAppsSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      {workspace !== null && (
        <div className="max-w-2xl space-y-10">
          <MyConnectedAppsSection />
          {canManageMembers(workspace.role) && (
            <WorkspaceConnectedAppsSection workspace={workspace} />
          )}
        </div>
      )}
    </WorkspaceShell>
  );
};

export default ConnectedAppsSettings;
