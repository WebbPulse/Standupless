/**
 * One team's issues as a list or a board, resolved from the `:keyPrefix` in
 * the route. The list and the board are the same page opened with a
 * different layout, so a filter or grouping carried in the URL survives a
 * switch between the two tabs.
 */

import React, { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useTeam } from '../../../hooks/useTeam';
import { useWorkspace } from '../../../hooks/useWorkspace';
import { canWriteIssues } from '../../../lib/capabilities';
import { errorMessage } from '../../../lib/errors';
import type { ViewLayout } from '../../../api/views';
import { defaultViewState } from '../../../lib/issueView';
import { ErrorAlert } from '../../ui/alert';
import EmptyState from '../../ui/empty-state';
import Spinner from '../../ui/spinner';
import TeamTabs from '../../workspace/TeamTabs';
import TeamTitle from '../../workspace/TeamTitle';
import WorkspaceShell from '../../workspace/WorkspaceShell';
import IssueViewPage from './IssueViewPage';

const BASES = {
  list: defaultViewState('list'),
  board: defaultViewState('board'),
} as const;

/** Props for TeamIssuesPage. */
export interface TeamIssuesPageProps {
  layout: ViewLayout;
}

/** The team's issues in the given layout. */
export const TeamIssuesPage: React.FC<TeamIssuesPageProps> = ({ layout }) => {
  const { keyPrefix, slug = '' } = useParams<{
    keyPrefix: string;
    slug: string;
  }>();
  const { workspace } = useWorkspace();
  const { team, workspaceId, isLoading, notFound, error } = useTeam(keyPrefix);
  const teams = useMemo(() => (team === null ? [] : [team]), [team]);
  const scope = useMemo(
    () => (team === null ? {} : { team_id: team.id }),
    [team]
  );

  if (notFound || (!isLoading && team === null)) {
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

  if (team === null) {
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

  return (
    <IssueViewPage
      key={team.id}
      workspaceId={workspaceId}
      slug={slug}
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      tabs={
        <TeamTabs
          slug={slug}
          keyPrefix={team.key_prefix}
          current={layout === 'board' ? 'board' : 'issues'}
        />
      }
      scopeKey={`team:${team.id}`}
      scope={scope}
      teams={teams}
      base={BASES[layout]}
      canEdit={canWriteIssues(workspace?.role, team.role)}
      homeTeam={team}
      emptyMessage={`No issues in ${team.name} match.`}
    />
  );
};

export default TeamIssuesPage;
