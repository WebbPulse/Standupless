/**
 * The workspace security settings page. Only an owner or admin may change the
 * authentication policy, who may invite and create teams, whether third-party
 * apps need approval, the approved email domains or single sign-on, the
 * same as the server allows, so anyone else is told so rather than shown controls that would
 * answer 403.
 */

import React from 'react';
import ApprovedDomainsSection from '../../components/workspace/ApprovedDomainsSection';
import PermissionsSection from '../../components/workspace/PermissionsSection';
import { SettingsAnchor } from '../../components/workspace/SettingsSearch';
import SsoSection from '../../components/workspace/SsoSection';
import ThirdPartyAppsSection from '../../components/workspace/ThirdPartyAppsSection';
import WorkspaceSecuritySection from '../../components/workspace/WorkspaceSecuritySection';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';

/**
 * Renders the workspace authentication policy, permissions, third-party app
 * approval, approved domains and single sign-on for an admin.
 */
const SecuritySettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell title="Settings">
      {workspace !== null && (
        <div className="max-w-2xl space-y-8">
          {canManageMembers(workspace.role) ? (
            <>
              <SettingsAnchor id="authentication">
                <WorkspaceSecuritySection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="permissions">
                <PermissionsSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="third-party-apps">
                <ThirdPartyAppsSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="approved-domains">
                <ApprovedDomainsSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="sso">
                <SsoSection workspace={workspace} />
              </SettingsAnchor>
            </>
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
