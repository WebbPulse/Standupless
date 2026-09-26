/**
 * One team's issue list, resolved from the `:keyPrefix` in the route. The
 * board, the cycles and the team's settings are separate routes rather than
 * tabs on this page, so each is a place a person can link to and return to.
 */

import React from 'react';
import { useParams } from 'react-router-dom';
import TeamIssues from '../../components/issues/TeamIssues';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';

/** The filtered issue list of the team named by the route's key prefix. */
const Team: React.FC = () => {
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
        <Spinner label="Loading team" />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null) {
    return (
      <WorkspaceShell title="Team not found">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this team.')}
          />
        )}
        <EmptyState message="No team in this workspace uses that key, or you do not have access to it." />
      </WorkspaceShell>
    );
  }

  return (
    <TeamIssues
      workspaceId={workspaceId}
      teamId={team.id}
      slug={slug ?? ''}
      estimateScale={team.estimate_scale}
      canCreate={canWriteIssues(workspace?.role, team.role)}
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      tabs={
        <TeamTabs
          slug={slug ?? ''}
          keyPrefix={team.key_prefix}
          current="issues"
        />
      }
    />
  );
};

export default Team;
