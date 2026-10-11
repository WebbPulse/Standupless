/**
 * One team's issues as a list or a board, resolved from the `:keyPrefix` in
 * the route. The list and the board are the same page opened with a
 * different layout, so a filter or grouping carried in the URL survives a
 * switch between the two tabs. The archive is the list again, reading only
 * the team's archived issues.
 *
 * A parent team's list and board roll up the issues of the sub-teams the
 * caller can see, as Linear does, with a toggle in the toolbar to show the
 * team's own issues alone. Turning the roll-up off is kept in the URL as
 * `subteams=0`, so a link to the narrower list stays narrow.
 */

import React, { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTeam } from '../../../hooks/useTeam';
import { useTeams } from '../../../hooks/useTeams';
import { useWorkspace } from '../../../hooks/useWorkspace';
import { canWriteIssues } from '../../../lib/capabilities';
import { errorMessage } from '../../../lib/errors';
import type { ViewLayout } from '../../../api/views';
import { defaultViewState } from '../../../lib/issueView';
import { ErrorAlert } from '../../ui/alert';
import Button from '../../ui/button';
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

/** The URL parameter that turns the sub-team roll-up off. */
const ROLL_UP_PARAM = 'subteams';

/** Props for TeamIssuesPage. */
export interface TeamIssuesPageProps {
  layout: ViewLayout;
  /** True for the team's archive, which lists its archived issues alone. */
  archive?: boolean;
}

/** The team's issues in the given layout. */
export const TeamIssuesPage: React.FC<TeamIssuesPageProps> = ({
  layout,
  archive = false,
}) => {
  const { keyPrefix, slug = '' } = useParams<{
    keyPrefix: string;
    slug: string;
  }>();
  const { workspace } = useWorkspace();
  const { team, workspaceId, isLoading, notFound, error } = useTeam(keyPrefix);
  const { data: allTeams } = useTeams();
  const [params, setParams] = useSearchParams();
  const subTeams = useMemo(
    () =>
      team === null
        ? []
        : (allTeams ?? []).filter((other) => other.parent_team_id === team.id),
    [allTeams, team]
  );
  const rollUp =
    !archive && subTeams.length > 0 && params.get(ROLL_UP_PARAM) !== '0';
  const teams = useMemo(
    () => (team === null ? [] : rollUp ? [team, ...subTeams] : [team]),
    [team, subTeams, rollUp]
  );
  const scope = useMemo(
    () =>
      team === null
        ? {}
        : {
            team_id: team.id,
            ...(archive ? { archived_only: true } : {}),
            ...(rollUp ? { include_sub_teams: true } : {}),
          },
    [team, archive, rollUp]
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

  if (archive) {
    return (
      <IssueViewPage
        key={`${team.id}:archive`}
        workspaceId={workspaceId}
        slug={slug}
        title={
          <TeamTitle
            name={`${team.name} archived issues`}
            keyPrefix={team.key_prefix}
          />
        }
        scopeKey={`team-archive:${team.id}`}
        scope={scope}
        teams={teams}
        base={BASES.list}
        canEdit={canWriteIssues(workspace?.role, team.role)}
        homeTeam={team}
        archive
        emptyMessage={`No archived issues in ${team.name}.`}
      />
    );
  }

  return (
    <IssueViewPage
      key={team.id}
      workspaceId={workspaceId}
      slug={slug}
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      tabs={
        <>
          <TeamTabs
            slug={slug}
            keyPrefix={team.key_prefix}
            current={layout === 'board' ? 'board' : 'issues'}
          />
          {subTeams.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={rollUp}
              data-testid="sub-team-roll-up"
              onClick={() => {
                const next = new URLSearchParams(params);
                if (rollUp) next.set(ROLL_UP_PARAM, '0');
                else next.delete(ROLL_UP_PARAM);
                setParams(next, { replace: true });
              }}
            >
              {rollUp ? 'Including sub-teams' : 'This team only'}
            </Button>
          )}
        </>
      }
      scopeKey={rollUp ? `team:${team.id}:sub-teams` : `team:${team.id}`}
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
