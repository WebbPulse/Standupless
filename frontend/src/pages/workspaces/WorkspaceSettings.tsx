/**
 * The workspace settings page: the logo, the accent color, the project update
 * cadence, members, invites, the GitHub connection, the outbound webhook
 * endpoints, the CSV export, and the danger zone where an owner or admin
 * schedules the workspace's deletion. Every section but the danger zone is for
 * an owner or admin, so a member reaching this route is told rather than shown
 * empty panels whose reads the API would refuse anyway, and is still offered
 * the danger zone's Leave workspace. The section nav is rendered either way, because
 * the API key and share link pages beside this one are open to any member.
 */

import React from 'react';
import AccentColorSection from '../../components/workspace/AccentColorSection';
import DangerZoneSection from '../../components/workspace/DangerZoneSection';
import ExportSection from '../../components/workspace/ExportSection';
import GithubSection from '../../components/workspace/GithubSection';
import SettingsNav from '../../components/workspace/SettingsNav';
import { SettingsAnchor } from '../../components/workspace/SettingsSearch';
import InvitesSection from '../../components/workspace/InvitesSection';
import MembersSection from '../../components/workspace/MembersSection';
import ProjectUpdatesSection from '../../components/workspace/ProjectUpdatesSection';
import WebhooksSection from '../../components/workspace/WebhooksSection';
import WorkspaceLogoSection from '../../components/workspace/WorkspaceLogoSection';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canInviteMembers, canManageMembers } from '../../lib/capabilities';

/** Renders the logo, accent color, member, invite, GitHub and webhook management for this workspace, and its danger zone. */
const WorkspaceSettings: React.FC = () => {
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
            <>
              <SettingsAnchor id="logo">
                <WorkspaceLogoSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="accent">
                <AccentColorSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="project-updates">
                <ProjectUpdatesSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="members">
                <MembersSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="invites">
                <InvitesSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="github">
                <GithubSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="webhooks">
                <WebhooksSection workspace={workspace} />
              </SettingsAnchor>
              <SettingsAnchor id="export">
                <ExportSection workspace={workspace} />
              </SettingsAnchor>
            </>
          ) : (
            <>
              <p className="text-sm text-text-muted">
                Only an owner or an admin can manage this workspace.
              </p>
              {canInviteMembers(workspace) && (
                <SettingsAnchor id="invites">
                  <InvitesSection workspace={workspace} />
                </SettingsAnchor>
              )}
            </>
          )}
          <DangerZoneSection workspace={workspace} />
        </div>
      )}
    </WorkspaceShell>
  );
};

export default WorkspaceSettings;
