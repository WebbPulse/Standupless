/**
 * Everything assigned to the signed in person across the workspace, which the
 * list route answers in one read because issues are workspace scoped and
 * `assignee_id=me` is resolved server side. Status and label filters are left
 * off: both are per team, and this list spans them.
 */

import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ME } from '../../api/issues';
import IssueFilters from '../../components/issues/IssueFilters';
import IssueList from '../../components/issues/IssueList';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { emptyFilters, filterQuery } from '../../lib/issueFilters';
import type { FilterState } from '../../lib/issueFilters';
import { issuesKey } from '../../lib/queryKeys';
import type { IssueRead } from '../../types/Api';
import { useTeams } from '../../hooks/useTeams';

/** The cross-team list of the caller's own issues. */
export const MyIssues: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const { workspace } = useWorkspace();
  const [filters, setFilters] = useState<FilterState>(emptyFilters);

  const workspaceId = workspace?.id ?? '';

  const { data: teams } = useTeams();

  const query = { assignee_id: ME, ...filterQuery(filters) };

  const teamNameFor = (issue: IssueRead): string | undefined =>
    teams?.find((team) => team.id === issue.team_id)?.name;

  return (
    <WorkspaceShell
      title="My issues"
      toolbar={
        <IssueFilters
          filters={filters}
          onChange={setFilters}
          statuses={[]}
          labels={[]}
          people={[]}
          scoped={false}
          hideAssignee
        />
      }
      flush
    >
      <IssueList
        workspaceId={workspaceId}
        slug={slug ?? ''}
        query={query}
        queryKey={issuesKey(workspaceId, 'mine', filters)}
        statuses={[]}
        labels={[]}
        people={[]}
        teamNameFor={teamNameFor}
        emptyMessage="Nothing is assigned to you right now."
      />
    </WorkspaceShell>
  );
};

export default MyIssues;
