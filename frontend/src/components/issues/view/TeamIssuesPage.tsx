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
 *
 * The list and the board open over the team's default display when its
 * admins have set one, and over the built-in display otherwise. A team admin
 * keeps or clears that default from the display menu; the archive always
 * opens over the built-in list.
 */

import React, { useCallback, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useParams } from 'react-router-dom';
import {
  getDisplayDefaults,
  updateDisplayDefaults,
  type TeamDisplayDefaultsUpdate,
} from '../../../api/teams';
import { useSubTeamRollUp } from '../../../hooks/useSubTeamRollUp';
import { useTeam } from '../../../hooks/useTeam';
import { useWorkspace } from '../../../hooks/useWorkspace';
import { canWriteIssues, isTeamAdmin } from '../../../lib/capabilities';
import { errorMessage } from '../../../lib/errors';
import type { ViewLayout } from '../../../api/views';
import { defaultViewState, type ViewState } from '../../../lib/issueView';
import { LOOKUP_POLL_MS } from '../../../lib/polling';
import { stateToTeamDisplay, teamDefaultState } from '../../../lib/teamDisplay';
import { ErrorAlert } from '../../ui/alert';
import EmptyState from '../../ui/empty-state';
import FavoriteButton from '../../ui/FavoriteButton';
import Spinner from '../../ui/spinner';
import SubTeamToggle from '../../workspace/SubTeamToggle';
import TeamTabs from '../../workspace/TeamTabs';
import TeamTitle from '../../workspace/TeamTitle';
import WorkspaceShell from '../../workspace/WorkspaceShell';
import IssueViewPage, { type TeamDefaultControl } from './IssueViewPage';

/** The built-in display the archive opens over. */
const ARCHIVE_BASE = defaultViewState('list');

/** The field of a team's display defaults that holds one layout's page. */
const PAGE_FIELD = {
  list: 'list_display',
  board: 'board_display',
} as const satisfies Record<ViewLayout, keyof TeamDisplayDefaultsUpdate>;

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
  const { subTeams, rollUp, toggle } = useSubTeamRollUp(team, !archive);
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
  const auth = useQueryAuth();
  const teamId = team?.id ?? '';
  const defaults = usePolledQuery(
    ({ signal }) => getDisplayDefaults(workspaceId, teamId, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: workspaceId !== '' && teamId !== '' && !archive,
      queryKey: ['team-display-defaults', workspaceId, teamId],
      auth,
    }
  );
  const field = PAGE_FIELD[layout];
  const stored = defaults.data?.[field];
  const base = useMemo(
    () => teamDefaultState(layout, stored),
    [layout, stored]
  );
  const refetchDefaults = defaults.refetch;
  const writeDefault = useCallback(
    async (state: ViewState | null) => {
      await updateDisplayDefaults(workspaceId, teamId, {
        [field]: state === null ? null : stateToTeamDisplay(state),
      });
      await refetchDefaults();
    },
    [workspaceId, teamId, field, refetchDefaults]
  );
  const admin = team !== null && isTeamAdmin(workspace?.role, team.role);
  const teamDefault = useMemo<TeamDefaultControl | undefined>(
    () =>
      admin
        ? {
            isSet: stored !== null && stored !== undefined,
            save: (state) => writeDefault(state),
            clear: () => writeDefault(null),
          }
        : undefined,
    [admin, stored, writeDefault]
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
        base={ARCHIVE_BASE}
        canEdit={canWriteIssues(workspace?.role, team.role)}
        homeTeam={team}
        archive
        emptyMessage={`No archived issues in ${team.name}.`}
      />
    );
  }

  if (defaults.isLoading && defaults.data === null) {
    return (
      <WorkspaceShell>
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
      titleAccessory={
        <FavoriteButton
          workspaceId={workspaceId}
          kind="team"
          targetId={team.id}
          title={team.name}
          preview={{ team_key_prefix: team.key_prefix }}
        />
      }
      tabs={
        <>
          <TeamTabs
            slug={slug}
            keyPrefix={team.key_prefix}
            teamId={team.id}
            current={layout === 'board' ? 'board' : 'issues'}
          />
          {subTeams.length > 0 && (
            <SubTeamToggle rollUp={rollUp} onToggle={toggle} />
          )}
        </>
      }
      scopeKey={rollUp ? `team:${team.id}:sub-teams` : `team:${team.id}`}
      scope={scope}
      teams={teams}
      base={base}
      teamDefault={teamDefault}
      canEdit={canWriteIssues(workspace?.role, team.role)}
      homeTeam={team}
      emptyMessage={`No issues in ${team.name} match.`}
    />
  );
};

export default TeamIssuesPage;
