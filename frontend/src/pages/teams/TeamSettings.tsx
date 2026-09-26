/**
 * One team's settings: the statuses its issues move through, its labels, who
 * belongs to it, and the rules that move an issue when a pull request changes.
 * These were a tab on the team page; they are a route of their own so a link
 * to them survives being sent to someone else.
 */

import React from 'react';
import { useParams } from 'react-router-dom';
import LabelsSection from '../../components/team/LabelsSection';
import TeamMembersSection from '../../components/team/TeamMembersSection';
import StatusesSection from '../../components/team/StatusesSection';
import TransitionsSection from '../../components/team/TransitionsSection';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers, isTeamAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';

/** The statuses, labels, members and transition rules of one team. */
const TeamSettings: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ keyPrefix: string; slug: string }>();
  const { workspace } = useWorkspace();
  const { team, workspaceId, isLoading, notFound, error } = useTeam(keyPrefix);

  if (isLoading) {
    return (
      <WorkspaceShell>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this team.')}
          />
        )}
        <Spinner label={'Loading team'} />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null) {
    return (
      <WorkspaceShell title={'Team not found'}>
        <EmptyState
          message={
            'No team in this workspace uses that key, or you do not have access to it.'
          }
        />
      </WorkspaceShell>
    );
  }

  const editable = isTeamAdmin(workspace?.role, team.role);

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <TeamTabs
          slug={slug ?? ''}
          keyPrefix={team.key_prefix}
          current="settings"
        />
      }
    >
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load this team.')}
        />
      )}
      <div className="max-w-2xl space-y-6">
        <StatusesSection
          workspaceId={workspaceId}
          teamId={team.id}
          canEdit={editable}
        />
        <LabelsSection
          workspaceId={workspaceId}
          teamId={team.id}
          canEdit={editable}
        />
        <TeamMembersSection
          workspaceId={workspaceId}
          teamId={team.id}
          canEdit={editable}
          canReadWorkspaceMembers={canManageMembers(workspace?.role)}
        />
        <TransitionsSection
          workspaceId={workspaceId}
          teamId={team.id}
          canEdit={editable}
        />
      </div>
    </WorkspaceShell>
  );
};

export default TeamSettings;
