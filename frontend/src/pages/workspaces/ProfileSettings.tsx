/**
 * The personal Profile page, Linear's Settings > Account > Profile: the
 * avatar, full name and username. These belong to the person rather than the
 * workspace, so a change here shows in every workspace they belong to.
 */

import React from 'react';
import ProfileSection from '../../components/account/ProfileSection';
import AvatarPanel from '../../components/auth/AvatarPanel';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeams } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';

/** Renders the caller's avatar, full name and username. */
const ProfileSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const { data: teams } = useTeams();

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      {workspace !== null && (
        <div className="max-w-2xl space-y-8">
          <ProfileSection
            workspaceId={workspace.id}
            teamIds={(teams ?? []).map((team) => team.id)}
          />
          <AvatarPanel />
        </div>
      )}
    </WorkspaceShell>
  );
};

export default ProfileSettings;
