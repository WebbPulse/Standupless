/**
 * The issues tab of one team: the shell with the team's title, the
 * filter bar in its toolbar, the flat list fixed to this team, and the
 * create dialog. The statuses, labels and members are read here rather than
 * inside the list, because the filter bar and the create form need the same
 * three lists and would otherwise read them twice.
 */

import React, { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { LuPlus } from 'react-icons/lu';
import { listLabels, listTeamMembers, listStatuses } from '../../api/teams';
import { emptyFilters, filterQuery } from '../../lib/issueFilters';
import type { FilterState } from '../../lib/issueFilters';
import {
  issuesKey,
  labelsKey,
  teamMembersKey,
  statusesKey,
} from '../../lib/queryKeys';
import type { EstimateScale } from '../../types/Api';
import Button from '../ui/button';
import WorkspaceShell from '../workspace/WorkspaceShell';
import CreateIssueDialog from './CreateIssueDialog';
import IssueFilters from './IssueFilters';
import IssueList from './IssueList';

/** Props for TeamIssues: which team, its title and tabs, and whether the caller may file one. */
export interface TeamIssuesProps {
  workspaceId: string;
  teamId: string;
  slug: string;
  estimateScale: EstimateScale;
  canCreate: boolean;
  /** The page title the shell shows, built by the team page. */
  title: ReactNode;
  /** The tab switch the team page places at the start of the toolbar. */
  tabs: ReactNode;
}

/** How often the supporting lists are re-read while the tab is open. */
const POLL_MS = 60000;

/** The filtered issue list for one team, in its shell, with its create form. */
export const TeamIssues: React.FC<TeamIssuesProps> = ({
  workspaceId,
  teamId,
  slug,
  estimateScale,
  canCreate,
  title,
  tabs,
}) => {
  const auth = useQueryAuth();
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [isCreating, setIsCreating] = useState(false);

  const authOption = { auth };

  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: statusesKey(teamId),
      ...authOption,
    }
  );

  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: labelsKey(teamId),
      ...authOption,
    }
  );

  const { data: people } = usePolledQuery(
    ({ signal }) => listTeamMembers(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: teamMembersKey(teamId),
      ...authOption,
    }
  );

  const query = { team_id: teamId, ...filterQuery(filters) };
  const listKey = issuesKey(workspaceId, teamId, filters);

  const closeDialog = useCallback((): void => {
    setIsCreating(false);
  }, []);

  const onCreated = useCallback((): void => {
    setIsCreating(false);
    invalidateQueries(listKey);
  }, [listKey]);

  return (
    <WorkspaceShell
      title={title}
      actions={
        canCreate ? (
          <Button
            variant="primary"
            onClick={() => {
              setIsCreating(true);
            }}
          >
            <LuPlus aria-hidden="true" />
            New issue
          </Button>
        ) : undefined
      }
      toolbar={
        <>
          {tabs}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <IssueFilters
              filters={filters}
              onChange={setFilters}
              statuses={statuses ?? []}
              labels={labels ?? []}
              people={people ?? []}
            />
          </div>
        </>
      }
      flush
    >
      <IssueList
        workspaceId={workspaceId}
        slug={slug}
        query={query}
        queryKey={listKey}
        statuses={statuses ?? []}
        labels={labels ?? []}
        people={people ?? []}
        emptyMessage="No issues in this team match these filters."
      />

      {isCreating && (
        <CreateIssueDialog
          workspaceId={workspaceId}
          teamId={teamId}
          estimateScale={estimateScale}
          statuses={statuses ?? []}
          labels={labels ?? []}
          people={people ?? []}
          onCreated={onCreated}
          onClose={closeDialog}
        />
      )}
    </WorkspaceShell>
  );
};

export default TeamIssues;
