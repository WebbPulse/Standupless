/**
 * One project's cycles. A cycle's status is derived by the server from its
 * dates, so this page never offers a status control on a row: it offers the
 * dates, and it offers cancelling, which is the one piece of state the dates
 * cannot imply.
 */

import React, { useCallback, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { useParams } from 'react-router-dom';
import {
  createCycle,
  deleteCycle,
  listCycles,
  updateCycle,
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
  CYCLE_STATUSES,
  CYCLE_STATUS_LABELS,
  completionPercent,
  countsLabel,
  cycleDatesLabel,
} from '../../lib/planningDisplay';
import { cyclesKey, projectsKey } from '../../lib/queryKeys';
import { validateCycleDates } from '../../lib/validation';
import type { CycleStatus } from '../../types/Api';

/** How often the lists re-read. */
const POLL_MS = 60000;

/** The cycles of the project named by the route's key prefix. */
export const Cycles: React.FC = () => {
  const { keyPrefix } = useParams<{ slug: string; keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [status, setStatus] = useState<CycleStatus | ''>('');
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [goal, setGoal] = useState('');

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
  const queryKey = cyclesKey(workspaceId, projectId, status);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listCycles(
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
      createCycle(workspaceId, {
        project_id: projectId,
        name: name.trim(),
        start_date: startDate,
        end_date: endDate,
        ...(goal.trim() === '' ? {} : { goal: goal.trim() }),
      }),
    queryKey
  );

  const { mutate: setCancelled, error: cancelError } = useMutationWithRefetch(
    (cycleId: string, cancelled: boolean) =>
      updateCycle(workspaceId, cycleId, { project_id: projectId, cancelled }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (cycleId: string) => deleteCycle(workspaceId, cycleId, projectId),
    queryKey
  );

  const canEdit = canWriteIssues(workspace?.role, project?.role);
  const isAdmin = isProjectAdmin(workspace?.role, project?.role);
  const dateError = validateCycleDates(startDate, endDate);
  const canAdd =
    name.trim() !== '' &&
    startDate !== '' &&
    endDate !== '' &&
    dateError === null;

  if (projects === null) {
    return (
      <WorkspaceShell>
        {projectsError !== null ? (
          <ErrorAlert
            message={errorMessage(projectsError, 'Could not load the cycles.')}
          />
        ) : (
          <Spinner label="Loading cycles" />
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

  const cycles = data?.cycles ?? [];

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl font-semibold text-white">
            {project.name} cycles
          </h2>
          <SelectField
            id="cycle-status"
            label="Status"
            className="w-44"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as CycleStatus | '');
            }}
          >
            <option value="">Any status</option>
            {CYCLE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {CYCLE_STATUS_LABELS[value]}
              </option>
            ))}
          </SelectField>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the cycles.')}
          />
        )}
        {addError !== null && (
          <ErrorAlert
            message={errorMessage(addError, 'Could not create that cycle.')}
          />
        )}
        {cancelError !== null && (
          <ErrorAlert
            message={errorMessage(cancelError, 'Could not change that cycle.')}
          />
        )}
        {removeError !== null && (
          <ErrorAlert
            message={errorMessage(removeError, 'Could not delete that cycle.')}
          />
        )}

        {isLoading ? (
          <Spinner label="Loading cycles" />
        ) : cycles.length === 0 ? (
          <p className="text-sm text-slate-400">No cycles yet.</p>
        ) : (
          <ul className="space-y-2">
            {cycles.map((cycle) => (
              <li
                key={cycle.cycle_id}
                className="space-y-1 rounded-md border border-slate-700 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-white">{cycle.name}</span>
                  <span className="text-xs text-slate-500">
                    {CYCLE_STATUS_LABELS[cycle.status]} ·{' '}
                    {cycleDatesLabel(cycle.start_date, cycle.end_date)}
                  </span>
                  {canEdit && (
                    <Button
                      variant="secondary"
                      className="ml-auto"
                      aria-label={
                        cycle.cancelled
                          ? `Restore ${cycle.name}`
                          : `Cancel ${cycle.name}`
                      }
                      onClick={() => {
                        void setCancelled(
                          cycle.cycle_id,
                          !cycle.cancelled
                        ).catch(() => undefined);
                      }}
                    >
                      {cycle.cancelled ? 'Restore' : 'Cancel'}
                    </Button>
                  )}
                  {isAdmin && (
                    <Button
                      variant="secondary"
                      aria-label={`Delete ${cycle.name}`}
                      onClick={() => {
                        void remove(cycle.cycle_id).catch(() => undefined);
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  {countsLabel(cycle.counts)} ·{' '}
                  {String(completionPercent(cycle.counts))}% complete
                </p>
                {cycle.goal !== null && (
                  <p className="text-xs text-slate-400">{cycle.goal}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-700 p-4">
            <Field
              id="new-cycle-name"
              label="New cycle"
              className="w-56"
              placeholder="Name it"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <Field
              id="new-cycle-start"
              label="Start date"
              type="date"
              className="w-40"
              value={startDate}
              onChange={(event) => {
                setStartDate(event.target.value);
              }}
            />
            <Field
              id="new-cycle-end"
              label="End date"
              type="date"
              className="w-40"
              value={endDate}
              onChange={(event) => {
                setEndDate(event.target.value);
              }}
            />
            <Field
              id="new-cycle-goal"
              label="Goal"
              className="w-64"
              placeholder="Optional"
              value={goal}
              onChange={(event) => {
                setGoal(event.target.value);
              }}
            />
            <Button
              disabled={isAdding || !canAdd}
              onClick={() => {
                void add()
                  .then(() => {
                    setName('');
                    setStartDate('');
                    setEndDate('');
                    setGoal('');
                  })
                  .catch(() => undefined);
              }}
            >
              {isAdding ? 'Creating' : 'Create cycle'}
            </Button>
            <ErrorAlert message={dateError} />
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Cycles;
