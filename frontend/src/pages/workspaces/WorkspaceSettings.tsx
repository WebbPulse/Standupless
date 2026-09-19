/**
 * The workspace settings page: members, invites, the GitHub connection and the
 * outbound webhook endpoints. Every section here is for an owner or admin, so a
 * member reaching this route is told rather than shown empty panels whose reads
 * the API would refuse anyway. The section nav is rendered either way, because
 * the API key and share link pages beside this one are open to any member.
 */

import React from 'react';
import GithubSection from '../../components/workspace/GithubSection';
import SettingsNav from '../../components/workspace/SettingsNav';
import InvitesSection from '../../components/workspace/InvitesSection';
import MembersSection from '../../components/workspace/MembersSection';
import WebhooksSection from '../../components/workspace/WebhooksSection';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';

/** Renders the member, invite, GitHub and webhook management for this workspace. */
const WorkspaceSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell>
      {workspace !== null && (
        <div className="space-y-8">
          <SettingsNav workspace={workspace} />
          {canManageMembers(workspace.role) ? (
            <>
              <MembersSection workspace={workspace} />
              <InvitesSection workspace={workspace} />
              <GithubSection workspace={workspace} />
              <WebhooksSection workspace={workspace} />
            </>
          ) : (
            <p className="text-sm text-slate-400">
              Only an owner or an admin can manage this workspace.
            </p>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
};

export default WorkspaceSettings;
