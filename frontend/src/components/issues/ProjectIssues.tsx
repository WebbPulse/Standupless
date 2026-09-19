/**
 * The issues tab of one project: the filter bar, the list fixed to this
 * project, and the create form. The statuses, labels and members are read here
 * rather than inside the list, because the filter bar and the create form need
 * the same three lists and would otherwise read them twice.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  listLabels,
  listProjectMembers,
  listStatuses,
} from '../../api/projects';
import { emptyFilters, filterQuery } from '../../lib/issueFilters';
import type { FilterState } from '../../lib/issueFilters';
import {
  issuesKey,
  labelsKey,
  projectMembersKey,
  statusesKey,
} from '../../lib/queryKeys';
import type { EstimateScale } from '../../types/Api';
import Button from '../ui/button';
import CreateIssueDialog from './CreateIssueDialog';
import IssueFilters from './IssueFilters';
import IssueList from './IssueList';

/** Props for ProjectIssues: which project, and whether the caller may file one. */
export interface ProjectIssuesProps {
  workspaceId: string;
  projectId: string;
  slug: string;
  estimateScale: EstimateScale;
  canCreate: boolean;
}

/** How often the supporting lists are re-read while the tab is open. */
const POLL_MS = 60000;

/** The filtered issue list for one project, with its create form. */
export const ProjectIssues: React.FC<ProjectIssuesProps> = ({
  workspaceId,
  projectId,
  slug,
  estimateScale,
  canCreate,
}) => {
  const auth = useQueryAuth();
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [isCreating, setIsCreating] = useState(false);

  const authOption = { auth };

  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: statusesKey(projectId),
      ...authOption,
    }
  );

  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: labelsKey(projectId),
      ...authOption,
    }
  );

  const { data: people } = usePolledQuery(
    ({ signal }) => listProjectMembers(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: projectMembersKey(projectId),
      ...authOption,
    }
  );

  const query = { project_id: projectId, ...filterQuery(filters) };
  const listKey = issuesKey(workspaceId, projectId, filters);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-medium text-white">Issues</h3>
        {canCreate && !isCreating && (
          <Button
            onClick={() => {
              setIsCreating(true);
            }}
          >
            New issue
          </Button>
        )}
      </div>

      {isCreating && (
        <CreateIssueDialog
          workspaceId={workspaceId}
          projectId={projectId}
          estimateScale={estimateScale}
          statuses={statuses ?? []}
          labels={labels ?? []}
          people={people ?? []}
          onCreated={() => {
            setIsCreating(false);
            invalidateQueries(listKey);
          }}
          onClose={() => {
            setIsCreating(false);
          }}
        />
      )}

      <IssueFilters
        filters={filters}
        onChange={setFilters}
        statuses={statuses ?? []}
        labels={labels ?? []}
        people={people ?? []}
      />

      <IssueList
        workspaceId={workspaceId}
        slug={slug}
        query={query}
        queryKey={listKey}
        statuses={statuses ?? []}
        labels={labels ?? []}
        people={people ?? []}
        emptyMessage="No issues in this project match these filters."
      />
    </section>
  );
};

export default ProjectIssues;
