/**
 * One team: an overview of what it is and how far along it is, then the
 * issues attached to it.
 *
 * The team rides in the query string rather than being looked up from the id,
 * because the planning table files a project under its team's prefix and the
 * API has no route that reads one without being told which team it belongs
 * to. A link that loses the parameter therefore cannot resolve, so the page
 * says so rather than showing an empty overview.
 */

import React, { useCallback, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuChevronRight, LuTrash2 } from 'react-icons/lu';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { deleteProject, getProject, updateProject } from '../../api/planning';
import { listLabels, listTeamMembers, listStatuses } from '../../api/teams';
import IssueList from '../../components/issues/IssueList';
import ProgressBar from '../../components/planning/ProgressBar';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { emptyFilters } from '../../lib/issueFilters';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  completionPercent,
  countsLabel,
  dateLabel,
} from '../../lib/planningDisplay';
import {
  issuesKey,
  labelsKey,
  projectsKey,
  teamMembersKey,
  statusesKey,
} from '../../lib/queryKeys';
import { projectsPath, teamPath } from '../../lib/paths';
import type { ProjectStatus } from '../../types/Api';

/** How often the team and its supporting lists re-read. */
const POLL_MS = 60000;

/** The trail back to the teams list and the owning team. */
const Crumbs: React.FC<{
  slug: string;
  teamName: string;
  teamKeyPrefix: string;
}> = ({ slug, teamName, teamKeyPrefix }) => (
  <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
    <Link
      to={projectsPath(slug)}
      className="rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
    >
      Projects
    </Link>
    <LuChevronRight
      className="h-3.5 w-3.5 text-text-faint"
      aria-hidden="true"
    />
    <Link
      to={teamPath(slug, teamKeyPrefix)}
      className="max-w-32 truncate rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
    >
      {teamName}
    </Link>
    <LuChevronRight
      className="h-3.5 w-3.5 text-text-faint"
      aria-hidden="true"
    />
  </span>
);

/** One team's overview and the issues attached to it. */
export const TeamDetail: React.FC = () => {
  const { id, slug } = useParams<{ id: string; slug: string }>();
  const [params] = useSearchParams();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const teamKeyPrefix = params.get('team') ?? '';
  const {
    team,
    workspaceId,
    isLoading: isResolving,
  } = useTeam(teamKeyPrefix === '' ? undefined : teamKeyPrefix);

  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const teamId = team?.id ?? '';
  const projectId = id ?? '';
  const queryKey = projectsKey(workspaceId, teamId, projectId);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getProject(workspaceId, projectId, teamId, signal),
    [workspaceId, projectId, teamId]
  );

  const {
    data: project,
    error,
    isLoading,
  } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: workspaceId !== '' && teamId !== '' && projectId !== '',
    queryKey,
    auth,
  });

  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: teamId !== '',
      queryKey: statusesKey(teamId),
      auth,
    }
  );

  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: teamId !== '',
      queryKey: labelsKey(teamId),
      auth,
    }
  );

  const { data: people } = usePolledQuery(
    ({ signal }) => listTeamMembers(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: teamId !== '',
      queryKey: teamMembersKey(teamId),
      auth,
    }
  );

  const { mutate: setStatus, error: statusError } = useMutationWithRefetch(
    (next: ProjectStatus) =>
      updateProject(workspaceId, projectId, {
        team_id: teamId,
        status: next,
      }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    () => deleteProject(workspaceId, projectId, teamId),
    projectsKey(workspaceId, teamId, '')
  );

  if (teamKeyPrefix === '') {
    return (
      <WorkspaceShell title="Project">
        <EmptyState
          message={
            'This link is missing the team it belongs to, so the project cannot be found. Open it from the projects list.'
          }
        />
      </WorkspaceShell>
    );
  }

  if (isResolving || isLoading) {
    return (
      <WorkspaceShell title="Project">
        <Spinner label={'Loading project'} />
      </WorkspaceShell>
    );
  }

  if (team === null || project === null) {
    return (
      <WorkspaceShell title={'Project not found'}>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this project.')}
          />
        )}
        <EmptyState
          message={
            'That project does not exist, or you do not have access to it.'
          }
        />
      </WorkspaceShell>
    );
  }

  const canEdit = canWriteIssues(workspace?.role, team.role);
  const isAdmin = isTeamAdmin(workspace?.role, team.role);
  const percent = completionPercent(project.counts);
  const listKey = issuesKey(workspaceId, `project:${projectId}`, emptyFilters);

  return (
    <WorkspaceShell
      title={project.name}
      leading={
        <Crumbs
          slug={slug ?? ''}
          teamName={team.name}
          teamKeyPrefix={team.key_prefix}
        />
      }
      actions={
        isAdmin ? (
          <IconButton
            label={`Delete ${project.name}`}
            size="sm"
            onClick={() => {
              setIsConfirmingDelete(true);
            }}
          >
            <LuTrash2 className="h-3.5 w-3.5" />
          </IconButton>
        ) : undefined
      }
      flush
    >
      <section className="space-y-3 border-b border-line px-4 py-4">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this project.')}
          />
        )}
        {statusError !== null && (
          <ErrorAlert
            message={errorMessage(statusError, 'Could not change the status.')}
          />
        )}
        {removeError !== null && (
          <ErrorAlert
            message={errorMessage(
              removeError,
              'Could not delete this project.'
            )}
          />
        )}

        <div className="flex flex-wrap items-center gap-3">
          <SelectField
            id="team-status"
            label="Status"
            hideLabel
            className="w-36"
            disabled={!canEdit}
            value={project.status}
            onChange={(event) => {
              void setStatus(event.target.value as ProjectStatus).catch(
                () => undefined
              );
            }}
          >
            {PROJECT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {PROJECT_STATUS_LABELS[value]}
              </option>
            ))}
          </SelectField>
          <span className="text-xs text-text-muted tabular-nums">
            {dateLabel(project.target_date, 'No target date')}
          </span>
          <span className="text-xs text-text-faint">{team.name}</span>
        </div>

        <div className="flex max-w-md items-center gap-3">
          <ProgressBar percent={percent} className="min-w-0 flex-1" />
          <span className="shrink-0 text-xs font-medium tabular-nums">
            {String(percent)}%
          </span>
        </div>
        <p className="text-xs text-text-muted tabular-nums">
          {countsLabel(project.counts)}
        </p>

        {project.description !== null && (
          <p className="max-w-2xl text-sm whitespace-pre-wrap text-text-muted">
            {project.description}
          </p>
        )}
      </section>

      <IssueList
        workspaceId={workspaceId}
        slug={slug ?? ''}
        query={{ team_id: teamId, project_id: projectId }}
        queryKey={listKey}
        statuses={statuses ?? []}
        labels={labels ?? []}
        people={people ?? []}
        emptyMessage={'No issues are in this project yet.'}
      />

      {isConfirmingDelete && isAdmin && (
        <Dialog
          open
          size="sm"
          title={`Delete ${project.name}`}
          description={
            'Its issues stay where they are and stop being attached to a project.'
          }
          onClose={() => {
            setIsConfirmingDelete(false);
          }}
        >
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setIsConfirmingDelete(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void remove()
                  .then(() => {
                    setIsConfirmingDelete(false);
                    void navigate(projectsPath(slug ?? ''));
                  })
                  .catch(() => undefined);
              }}
            >
              Delete project
            </Button>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default TeamDetail;
