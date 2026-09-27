/**
 * Everything assigned to the signed in person across the workspace, drawn as
 * the same grouped list or board as a team's issues. The read is fixed to
 * `assignee_id=me`, resolved server side, and spans every team the caller
 * belongs to, so rows name their team and statuses group by name.
 */

import React, { useMemo } from 'react';
import { ME, type IssueListFilters } from '../../api/issues';
import IssueViewPage from '../../components/issues/view/IssueViewPage';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { defaultViewState, type FilterField } from '../../lib/issueView';

/** The fixed part of the read. */
const SCOPE: IssueListFilters = { assignee_id: ME };

/** The assignee is fixed by the page, so it is not offered as a filter. */
const HIDDEN_FILTERS: FilterField[] = ['assignee'];

/** The cross-team list of the caller's own issues. */
export const MyIssues: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams, isLoading, error } = useTeam(undefined);
  const base = useMemo(() => defaultViewState('list'), []);
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';

  if (workspace === null || teams.length === 0) {
    return (
      <WorkspaceShell title="My issues" flush>
        {error !== null && error !== undefined ? (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={errorMessage(error, 'Could not load your teams.')}
            />
          </div>
        ) : isLoading || workspace === null ? (
          <SkeletonRows label="Loading issues" />
        ) : (
          <EmptyState message="Nothing is assigned to you right now." />
        )}
      </WorkspaceShell>
    );
  }

  const canEdit = teams.some((team) =>
    canWriteIssues(workspace.role, team.role)
  );

  return (
    <IssueViewPage
      workspaceId={workspaceId}
      slug={slug}
      title="My issues"
      scopeKey="mine"
      scope={SCOPE}
      teams={teams}
      base={base}
      canEdit={canEdit}
      homeTeam={teams.length === 1 ? teams[0] : undefined}
      emptyMessage="Nothing is assigned to you right now."
      hideFilterFields={HIDDEN_FILTERS}
    />
  );
};

export default MyIssues;
