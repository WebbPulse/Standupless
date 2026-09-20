/**
 * One project's milestones. Unlike a cycle a milestone's status is stored, so
 * this page offers it directly: a target date alone cannot say whether the
 * work has begun, which is the difference the contract draws between the two.
 */

import React, { useCallback, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuChevronRight, LuMilestone, LuTrash2 } from 'react-icons/lu';
import { useParams } from 'react-router-dom';
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  updateMilestone,
} from '../../api/planning';
import { listProjects } from '../../api/projects';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues, isProjectAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import {
  MILESTONE_STATUSES,
  MILESTONE_STATUS_LABELS,
  completionPercent,
  countsLabel,
  dateLabel,
} from '../../lib/planningDisplay';
import { milestonesKey, projectsKey } from '../../lib/queryKeys';
import { validateTargetDate } from '../../lib/validation';
import type { MilestoneStatus } from '../../types/Api';

/** How often the lists re-read. */
const POLL_MS = 60000;

/** The project name before the page title, as a breadcrumb. */
const Crumb: React.FC<{ name: string }> = ({ name }) => (
  <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
    <span className="max-w-48 truncate">{name}</span>
    <LuChevronRight
      className="h-3.5 w-3.5 text-text-faint"
      aria-hidden="true"
    />
  </span>
);

/** The milestones of the project named by the route's key prefix. */
export const Milestones: React.FC = () => {
  const { keyPrefix } = useParams<{ slug: string; keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [status, setStatus] = useState<MilestoneStatus | ''>('');
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [description, setDescription] = useState('');

  const workspaceId = workspace?.id ?? '';

  const { data: projects, error: projectsError } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: projectsKey(workspaceId),
      auth,
    }
  );

  const project = (projects ?? []).find(
    (item) => item.key_prefix === keyPrefix
  );
  const projectId = project?.id ?? '';
  const queryKey = milestonesKey(workspaceId, projectId, status);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listMilestones(
        workspaceId,
        { project_id: projectId, ...(status === '' ? {} : { status }) },
        signal
      ),
    [workspaceId, projectId, status]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: projectId !== '',
    queryKey,
    auth,
  });

  const {
    mutate: add,
    isMutating: isAdding,
    error: addError,
  } = useMutationWithRefetch(
    () =>
      createMilestone(workspaceId, {
        project_id: projectId,
        name: name.trim(),
        ...(targetDate === '' ? {} : { target_date: targetDate }),
        ...(description.trim() === ''
          ? {}
          : { description: description.trim() }),
      }),
    queryKey
  );

  const { mutate: setStatusOf, error: statusError } = useMutationWithRefetch(
    (milestoneId: string, next: MilestoneStatus) =>
      updateMilestone(workspaceId, milestoneId, {
        project_id: projectId,
        status: next,
      }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (milestoneId: string) =>
      deleteMilestone(workspaceId, milestoneId, projectId),
    queryKey
  );

  const canEdit = canWriteIssues(workspace?.role, project?.role);
  const isAdmin = isProjectAdmin(workspace?.role, project?.role);
  const dateError = validateTargetDate(targetDate);
  const canAdd = name.trim() !== '' && dateError === null;

  if (projects === null) {
    return (
      <WorkspaceShell title="Milestones">
        {projectsError !== null ? (
          <ErrorAlert
            message={errorMessage(
              projectsError,
              'Could not load the milestones.'
            )}
          />
        ) : (
          <Spinner label="Loading milestones" />
        )}
      </WorkspaceShell>
    );
  }

  if (project === undefined) {
    return (
      <WorkspaceShell title="Milestones">
        <EmptyState message="That project does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  const milestones = data?.milestones ?? [];

  return (
    <WorkspaceShell
      title="Milestones"
      leading={<Crumb name={project.name} />}
      toolbar={
        <SelectField
          id="milestone-status"
          label="Status"
          hideLabel
          className="w-40"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as MilestoneStatus | '');
          }}
        >
          <option value="">Any status</option>
          {MILESTONE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {MILESTONE_STATUS_LABELS[value]}
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
                id="new-milestone-name"
                label="New milestone"
                className="w-full sm:w-56"
                placeholder="Name it"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <Field
                id="new-milestone-target"
                label="Target date"
                type="date"
                className="w-40"
                value={targetDate}
                onChange={(event) => {
                  setTargetDate(event.target.value);
                }}
              />
              <Field
                id="new-milestone-description"
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
                {isAdding ? 'Creating' : 'Create milestone'}
              </Button>
            </div>
            <ErrorAlert message={dateError} />
          </div>
        )}

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the milestones.')}
          />
        )}
        {addError !== null && (
          <ErrorAlert
            message={errorMessage(addError, 'Could not create that milestone.')}
          />
        )}
        {statusError !== null && (
          <ErrorAlert
            message={errorMessage(
              statusError,
              'Could not change that milestone.'
            )}
          />
        )}
        {removeError !== null && (
          <ErrorAlert
            message={errorMessage(
              removeError,
              'Could not delete that milestone.'
            )}
          />
        )}

        {isLoading ? (
          <Spinner label="Loading milestones" />
        ) : milestones.length === 0 ? (
          <EmptyState icon={<LuMilestone />} message="No milestones yet." />
        ) : (
          <ul className="rounded-md border border-line">
            {milestones.map((milestone) => {
              const percent = completionPercent(milestone.counts);
              return (
                <li
                  key={milestone.milestone_id}
                  className="flex h-row items-center gap-3 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
                >
                  <LuMilestone
                    className="h-4 w-4 shrink-0 text-text-faint"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {milestone.name}
                    {milestone.description !== null && (
                      <span className="ml-2 hidden font-normal text-text-faint lg:inline">
                        {milestone.description}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs whitespace-nowrap text-text-muted tabular-nums">
                    {dateLabel(milestone.target_date, 'No target date')}
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
                    {countsLabel(milestone.counts)}
                  </span>
                  <SelectField
                    id={`milestone-status-${milestone.milestone_id}`}
                    label={`Status of ${milestone.name}`}
                    hideLabel
                    className="w-32 shrink-0"
                    disabled={!canEdit}
                    value={milestone.status}
                    onChange={(event) => {
                      void setStatusOf(
                        milestone.milestone_id,
                        event.target.value as MilestoneStatus
                      ).catch(() => undefined);
                    }}
                  >
                    {MILESTONE_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {MILESTONE_STATUS_LABELS[value]}
                      </option>
                    ))}
                  </SelectField>
                  {isAdmin && (
                    <IconButton
                      label={`Delete ${milestone.name}`}
                      size="sm"
                      onClick={() => {
                        void remove(milestone.milestone_id).catch(
                          () => undefined
                        );
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

export default Milestones;
