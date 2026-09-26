/**
 * One team's board, with the filters it reads under and the saved views that
 * store those filters. Applying a saved view sets the filter state here and the
 * board re-reads under the new key, which is the same path a person typing into
 * the filter bar takes, so a stored view can never reach a row a live filter
 * could not.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useParams } from 'react-router-dom';
import { listLabels, listTeamMembers, listTeams } from '../../api/teams';
import BoardView from '../../components/views/BoardView';
import SavedViewsPanel from '../../components/views/SavedViewsPanel';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import { personLabel } from '../../lib/issuePeople';
import {
  labelsKey,
  teamMembersKey,
  teamsKey,
  type BoardKeyFilters,
} from '../../lib/queryKeys';
import type { SavedViewRead } from '../../types/Api';
import { fromViewFilter, toViewFilter } from '../../lib/viewFilters';

/** How often the supporting lists re-read. */
const POLL_MS = 60000;

/** The filters a board starts with, which is everything in the team. */
const NO_FILTERS: BoardKeyFilters = {
  assigneeId: '',
  labelId: '',
  priority: '',
};

/** The board for the team named by the route's key prefix. */
export const Board: React.FC = () => {
  const { slug, keyPrefix } = useParams<{ slug: string; keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [filters, setFilters] = useState<BoardKeyFilters>(NO_FILTERS);

  const workspaceId = workspace?.id ?? '';

  const { data: teams, error: teamsError } = usePolledQuery(
    ({ signal }) => listTeams(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: teamsKey(workspaceId),
      auth,
    }
  );

  const team = (teams ?? []).find((item) => item.key_prefix === keyPrefix);
  const teamId = team?.id ?? '';
  const hasTeam = teamId !== '';

  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasTeam,
      queryKey: labelsKey(teamId),
      auth,
    }
  );

  const { data: people } = usePolledQuery(
    ({ signal }) => listTeamMembers(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasTeam,
      queryKey: teamMembersKey(teamId),
      auth,
    }
  );

  const canEdit = canWriteIssues(workspace?.role, team?.role);

  const applyView = (view: SavedViewRead): void => {
    setFilters(fromViewFilter(view.filter));
  };

  if (teams === null) {
    return (
      <WorkspaceShell title="Board">
        {teamsError !== null ? (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load the board.')}
          />
        ) : (
          <Spinner label="Loading board" />
        )}
      </WorkspaceShell>
    );
  }

  if (team === undefined) {
    return (
      <WorkspaceShell title="Board">
        <EmptyState
          message={'That team does not exist, or you are not a member of it.'}
        />
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <>
          <TeamTabs
            slug={slug ?? ''}
            keyPrefix={team.key_prefix}
            current="board"
          />
          <SelectField
            id="board-assignee"
            label="Assignee"
            hideLabel
            className="w-40"
            value={filters.assigneeId}
            onChange={(event) => {
              setFilters((held) => ({
                ...held,
                assigneeId: event.target.value,
              }));
            }}
          >
            <option value="">Anyone</option>
            {(people ?? []).map((person) => (
              <option key={person.user_id} value={person.user_id}>
                {personLabel(person)}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="board-label"
            label="Label"
            hideLabel
            className="w-40"
            value={filters.labelId}
            onChange={(event) => {
              setFilters((held) => ({ ...held, labelId: event.target.value }));
            }}
          >
            <option value="">Any label</option>
            {(labels ?? []).map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="board-priority"
            label="Priority"
            hideLabel
            className="w-40"
            value={filters.priority}
            onChange={(event) => {
              setFilters((held) => ({
                ...held,
                priority: event.target.value,
              }));
            }}
          >
            <option value="">Any priority</option>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </SelectField>
        </>
      }
      flush
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <BoardView
          workspaceId={workspaceId}
          teamId={teamId}
          slug={slug ?? ''}
          filters={filters}
          people={people ?? []}
          canEdit={canEdit}
        />

        <SavedViewsPanel
          workspaceId={workspaceId}
          teamId={teamId}
          currentFilter={toViewFilter(filters)}
          currentKind="board"
          onApply={applyView}
        />
      </div>
    </WorkspaceShell>
  );
};

export default Board;
