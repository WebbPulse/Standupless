/**
 * Composes a new view. It is the issue list over every team the caller can
 * see, opened with the save bar showing, so filters and display options change
 * the results live and Save asks only for the name, look and location.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import IssueViewPage from '../../components/issues/view/IssueViewPage';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { defaultViewState } from '../../lib/issueView';
import { viewsPath } from '../../lib/paths';

/** The new view page. */
export const NewView: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const [base] = useState(() => defaultViewState());
  const [scope] = useState(() => ({}));
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';

  const leading = (
    <Link
      to={viewsPath(slug)}
      className="text-sm text-text-muted hover:text-text"
    >
      Views
    </Link>
  );

  if (teams.length === 0) {
    return (
      <WorkspaceShell title="New view" leading={leading} flush>
        <SkeletonRows label="Loading teams" />
      </WorkspaceShell>
    );
  }

  return (
    <IssueViewPage
      workspaceId={workspaceId}
      slug={slug}
      title="New view"
      leading={leading}
      scopeKey="view:new"
      scope={scope}
      teams={teams}
      base={base}
      composing
      canEdit={teams.some((team) => canWriteIssues(workspace?.role, team.role))}
      homeTeam={teams.length === 1 ? teams[0] : undefined}
      emptyMessage="No issues match these filters."
    />
  );
};

export default NewView;
