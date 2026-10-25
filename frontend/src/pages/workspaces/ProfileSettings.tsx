/**
 * The personal Profile page, Linear's Settings > Account > Profile: the
 * avatar, full name and username. These belong to the person rather than the
 * workspace, so a change here shows in every workspace they belong to.
 */

import React from 'react';
import ProfileSection from '../../components/account/ProfileSection';
import AvatarPanel from '../../components/auth/AvatarPanel';
import { SettingsAnchor } from '../../components/workspace/SettingsSearch';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeams } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';

/** Renders the caller's avatar, full name and username. */
const ProfileSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const { data: teams } = useTeams();

  return (
    <WorkspaceShell title="Settings">
      {workspace !== null && (
        <div className="max-w-2xl space-y-8">
          <SettingsAnchor id="profile">
            <ProfileSection
              workspaceId={workspace.id}
              teamIds={(teams ?? []).map((team) => team.id)}
            />
          </SettingsAnchor>
          <SettingsAnchor id="avatar">
            <AvatarPanel />
          </SettingsAnchor>
        </div>
      )}
    </WorkspaceShell>
  );
};

export default ProfileSettings;
