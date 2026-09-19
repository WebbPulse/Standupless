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
import { useParams } from 'react-router-dom';
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  updateMilestone,
} from '../../api/planning';
import { listProjects } from '../../api/projects';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
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
      <WorkspaceShell>
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
      <WorkspaceShell>
        <p className="text-sm text-slate-400">
          That project does not exist, or you are not a member of it.
        </p>
      </WorkspaceShell>
    );
  }

  const milestones = data?.milestones ?? [];

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl font-semibold text-white">
            {project.name} milestones
          </h2>
          <SelectField
            id="milestone-status"
            label="Status"
            className="w-44"
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
        </div>

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
          <p className="text-sm text-slate-400">No milestones yet.</p>
        ) : (
          <ul className="space-y-2">
            {milestones.map((milestone) => (
              <li
                key={milestone.milestone_id}
                className="space-y-1 rounded-md border border-slate-700 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-white">{milestone.name}</span>
                  <span className="text-xs text-slate-500">
                    {dateLabel(milestone.target_date, 'No target date')}
                  </span>
                  <SelectField
                    id={`milestone-status-${milestone.milestone_id}`}
                    label="Status"
                    className="ml-auto w-40"
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
                    <Button
                      variant="secondary"
                      aria-label={`Delete ${milestone.name}`}
                      onClick={() => {
                        void remove(milestone.milestone_id).catch(
                          () => undefined
                        );
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  {countsLabel(milestone.counts)} ·{' '}
                  {String(completionPercent(milestone.counts))}% complete
                </p>
                {milestone.description !== null && (
                  <p className="text-xs text-slate-400">
                    {milestone.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-700 p-4">
            <Field
              id="new-milestone-name"
              label="New milestone"
              className="w-56"
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
              className="w-64"
              placeholder="Optional"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
            <Button
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
            <ErrorAlert message={dateError} />
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Milestones;
