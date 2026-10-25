/**
 * The Customers page of workspace settings: the statuses and tiers customers
 * pick from. Any member reads both lists with how many customers hold each
 * entry; a workspace owner or admin adds, renames, recolours, reorders and
 * deletes them, and deleting an entry customers hold moves them to another.
 */

import React from 'react';
import CustomerFieldsEditor from '../../components/customers/CustomerFieldsEditor';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';

/** Lists and edits the workspace's customer statuses and tiers. */
const CustomersSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id ?? '';
  const canEdit = canManageMembers(workspace?.role);
  const isGuest = workspace?.role === 'guest';

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      <div className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Customers</h2>
          <p className="text-sm text-text-muted">
            The statuses and tiers every customer picks from. Only a workspace
            admin changes them here.
          </p>
        </div>
        {isGuest ? (
          <p className="text-sm text-text-muted">
            Customers are open to workspace members, not guests.
          </p>
        ) : (
          <>
            <CustomerFieldsEditor
              workspaceId={workspaceId}
              kind="statuses"
              canEdit={canEdit}
            />
            <CustomerFieldsEditor
              workspaceId={workspaceId}
              kind="tiers"
              canEdit={canEdit}
            />
          </>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default CustomersSettings;
