/**
 * One team's projects. Unlike a cycle a project's status is stored, so
 * this page offers it directly: a target date alone cannot say whether the
 * work has begun, which is the difference the contract draws between the two.
 */

import React, { useCallback, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuBox, LuChevronRight, LuTrash2 } from 'react-icons/lu';
import { useParams } from 'react-router-dom';
import {
  createProject,
  deleteProject,
  listProjects,
  updateProject,
} from '../../api/planning';
import { listTeams } from '../../api/teams';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  completionPercent,
  countsLabel,
  dateLabel,
} from '../../lib/planningDisplay';
import { projectsKey, teamsKey } from '../../lib/queryKeys';
import { validateTargetDate } from '../../lib/validation';
import type { ProjectStatus } from '../../types/Api';

/** How often the lists re-read. */
const POLL_MS = 60000;

/** The team name before the page title, as a breadcrumb. */
const Crumb: React.FC<{ name: string }> = ({ name }) => (
  <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
    <span className="max-w-48 truncate">{name}</span>
    <LuChevronRight
      className="h-3.5 w-3.5 text-text-faint"
      aria-hidden="true"
    />
  </span>
);

/** The projects of the team named by the route's key prefix. */
export const Projects: React.FC = () => {
  const { keyPrefix } = useParams<{ slug: string; keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [status, setStatus] = useState<ProjectStatus | ''>('');
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [description, setDescription] = useState('');

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
  const queryKey = projectsKey(workspaceId, teamId, status);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listProjects(
        workspaceId,
        { team_id: teamId, ...(status === '' ? {} : { status }) },
        signal
      ),
    [workspaceId, teamId, status]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: teamId !== '',
    queryKey,
    auth,
  });

  const {
    mutate: add,
    isMutating: isAdding,
    error: addError,
  } = useMutationWithRefetch(
    () =>
      createProject(workspaceId, {
        team_id: teamId,
        name: name.trim(),
        ...(targetDate === '' ? {} : { target_date: targetDate }),
        ...(description.trim() === ''
          ? {}
          : { description: description.trim() }),
      }),
    queryKey
  );

  const { mutate: setStatusOf, error: statusError } = useMutationWithRefetch(
    (projectId: string, next: ProjectStatus) =>
      updateProject(workspaceId, projectId, {
        team_id: teamId,
        status: next,
      }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (projectId: string) => deleteProject(workspaceId, projectId, teamId),
    queryKey
  );

  const canEdit = canWriteIssues(workspace?.role, team?.role);
  const isAdmin = isTeamAdmin(workspace?.role, team?.role);
  const dateError = validateTargetDate(targetDate);
  const canAdd = name.trim() !== '' && dateError === null;

  if (teams === null) {
    return (
      <WorkspaceShell title="Projects">
        {teamsError !== null ? (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load the projects.')}
          />
        ) : (
          <Spinner label="Loading projects" />
        )}
      </WorkspaceShell>
    );
  }

  if (team === undefined) {
    return (
      <WorkspaceShell title="Projects">
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  const projects = data?.projects ?? [];

  return (
    <WorkspaceShell
      title="Projects"
      leading={<Crumb name={team.name} />}
      toolbar={
        <SelectField
          id="project-status"
          label="Status"
          hideLabel
          className="w-40"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as ProjectStatus | '');
          }}
        >
          <option value="">Any status</option>
          {PROJECT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {PROJECT_STATUS_LABELS[value]}
            </option>
          ))}
        </SelectField>
      }
    >
      <div className="space-y-6">
        {canEdit && (
          <div className="space-y-3 rounded-md border border-line p-4">
            <div className="flex flex-wrap items-end gap-3">
              <Field
                id="new-project-name"
                label="New project"
                className="w-full sm:w-56"
                placeholder="Name it"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <Field
                id="new-project-target"
                label="Target date"
                type="date"
                className="w-40"
                value={targetDate}
                onChange={(event) => {
                  setTargetDate(event.target.value);
                }}
              />
              <Field
                id="new-project-description"
                label="Description"
                className="min-w-48 flex-1"
                placeholder="Optional"
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
              <Button
                variant="primary"
                disabled={isAdding || !canAdd}
                onClick={() => {
                  void add()
                    .then(() => {
                      setName('');
                      setTargetDate('');
                      setDescription('');
                    })
                    .catch(() => undefined);
                }}
              >
                {isAdding ? 'Creating' : 'Create project'}
              </Button>
            </div>
            <ErrorAlert message={dateError} />
          </div>
        )}

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the projects.')}
          />
        )}
        {addError !== null && (
          <ErrorAlert
            message={errorMessage(addError, 'Could not create that project.')}
          />
        )}
        {statusError !== null && (
          <ErrorAlert
            message={errorMessage(
              statusError,
              'Could not change that project.'
            )}
          />
        )}
        {removeError !== null && (
          <ErrorAlert
            message={errorMessage(
              removeError,
              'Could not delete that project.'
            )}
          />
        )}

        {isLoading ? (
          <Spinner label="Loading projects" />
        ) : projects.length === 0 ? (
          <EmptyState icon={<LuBox />} message="No projects yet." />
        ) : (
          <ul className="rounded-md border border-line">
            {projects.map((project) => {
              const percent = completionPercent(project.counts);
              return (
                <li
                  key={project.project_id}
                  className="flex h-row items-center gap-3 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
                >
                  <LuBox
                    className="h-4 w-4 shrink-0 text-text-faint"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {project.name}
                    {project.description !== null && (
                      <span className="ml-2 hidden font-normal text-text-faint lg:inline">
                        {project.description}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs whitespace-nowrap text-text-muted tabular-nums">
                    {dateLabel(project.target_date, 'No target date')}
                  </span>
                  <span
                    aria-hidden="true"
                    className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-accent-soft md:block"
                  >
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${String(percent)}%` }}
                    />
                  </span>
                  <span className="hidden shrink-0 text-xs text-text-muted tabular-nums md:block">
                    {countsLabel(project.counts)}
                  </span>
                  <SelectField
                    id={`project-status-${project.project_id}`}
                    label={`Status of ${project.name}`}
                    hideLabel
                    className="w-32 shrink-0"
                    disabled={!canEdit}
                    value={project.status}
                    onChange={(event) => {
                      void setStatusOf(
                        project.project_id,
                        event.target.value as ProjectStatus
                      ).catch(() => undefined);
                    }}
                  >
                    {PROJECT_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {PROJECT_STATUS_LABELS[value]}
                      </option>
                    ))}
                  </SelectField>
                  {isAdmin && (
                    <IconButton
                      label={`Delete ${project.name}`}
                      size="sm"
                      onClick={() => {
                        void remove(project.project_id).catch(() => undefined);
                      }}
                    >
                      <LuTrash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Projects;
