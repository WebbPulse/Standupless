/**
 * One team's cycles. A cycle's status is derived by the server from its
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
import {
  LuBan,
  LuChevronRight,
  LuLayers,
  LuRotateCcw,
  LuTrash2,
} from 'react-icons/lu';
import { useParams } from 'react-router-dom';
import {
  createCycle,
  deleteCycle,
  listCycles,
  updateCycle,
} from '../../api/planning';
import { listTeams } from '../../api/teams';
import { ErrorAlert } from '../../components/ui/alert';
import Badge, { type BadgeTone } from '../../components/ui/badge';
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
  CYCLE_STATUSES,
  CYCLE_STATUS_LABELS,
  completionPercent,
  countsLabel,
  cycleDatesLabel,
} from '../../lib/planningDisplay';
import { cyclesKey, teamsKey } from '../../lib/queryKeys';
import { validateCycleDates } from '../../lib/validation';
import type { CycleStatus } from '../../types/Api';

/** How often the lists re-read. */
const POLL_MS = 60000;

/** The badge tint each cycle status takes. */
const STATUS_TONES: Record<CycleStatus, BadgeTone> = {
  upcoming: 'neutral',
  active: 'accent',
  completed: 'success',
  cancelled: 'danger',
};

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

/** The cycles of the team named by the route's key prefix. */
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
  const queryKey = cyclesKey(workspaceId, teamId, status);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listCycles(
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
      createCycle(workspaceId, {
        team_id: teamId,
        name: name.trim(),
        start_date: startDate,
        end_date: endDate,
        ...(goal.trim() === '' ? {} : { goal: goal.trim() }),
      }),
    queryKey
  );

  const { mutate: setCancelled, error: cancelError } = useMutationWithRefetch(
    (cycleId: string, cancelled: boolean) =>
      updateCycle(workspaceId, cycleId, { team_id: teamId, cancelled }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (cycleId: string) => deleteCycle(workspaceId, cycleId, teamId),
    queryKey
  );

  const canEdit = canWriteIssues(workspace?.role, team?.role);
  const isAdmin = isTeamAdmin(workspace?.role, team?.role);
  const dateError = validateCycleDates(startDate, endDate);
  const canAdd =
    name.trim() !== '' &&
    startDate !== '' &&
    endDate !== '' &&
    dateError === null;

  if (teams === null) {
    return (
      <WorkspaceShell title="Cycles">
        {teamsError !== null ? (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load the cycles.')}
          />
        ) : (
          <Spinner label="Loading cycles" />
        )}
      </WorkspaceShell>
    );
  }

  if (team === undefined) {
    return (
      <WorkspaceShell title="Cycles">
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  const cycles = data?.cycles ?? [];

  return (
    <WorkspaceShell
      title="Cycles"
      leading={<Crumb name={team.name} />}
      toolbar={
        <SelectField
          id="cycle-status"
          label="Status"
          hideLabel
          className="w-40"
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
      }
    >
      <div className="space-y-6">
        {canEdit && (
          <div className="space-y-3 rounded-md border border-line p-4">
            <div className="flex flex-wrap items-end gap-3">
              <Field
                id="new-cycle-name"
                label="New cycle"
                className="w-full sm:w-56"
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
                className="min-w-48 flex-1"
                placeholder="Optional"
                value={goal}
                onChange={(event) => {
                  setGoal(event.target.value);
                }}
              />
              <Button
                variant="primary"
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
            </div>
            <ErrorAlert message={dateError} />
          </div>
        )}

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
          <EmptyState icon={<LuLayers />} message="No cycles yet." />
        ) : (
          <ul className="rounded-md border border-line">
            {cycles.map((cycle) => {
              const percent = completionPercent(cycle.counts);
              return (
                <li
                  key={cycle.cycle_id}
                  className="flex h-row items-center gap-3 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
                >
                  <LuLayers
                    className="h-4 w-4 shrink-0 text-text-faint"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {cycle.name}
                    {cycle.goal !== null && (
                      <span className="ml-2 hidden font-normal text-text-faint lg:inline">
                        {cycle.goal}
                      </span>
                    )}
                  </span>
                  <Badge tone={STATUS_TONES[cycle.status]}>
                    {CYCLE_STATUS_LABELS[cycle.status]}
                  </Badge>
                  <span className="shrink-0 text-xs whitespace-nowrap text-text-muted tabular-nums">
                    {cycleDatesLabel(cycle.start_date, cycle.end_date)}
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
                    {countsLabel(cycle.counts)}
                  </span>
                  {canEdit && (
                    <IconButton
                      label={
                        cycle.cancelled
                          ? `Restore ${cycle.name}`
                          : `Cancel ${cycle.name}`
                      }
                      size="sm"
                      onClick={() => {
                        void setCancelled(
                          cycle.cycle_id,
                          !cycle.cancelled
                        ).catch(() => undefined);
                      }}
                    >
                      {cycle.cancelled ? (
                        <LuRotateCcw className="h-3.5 w-3.5" />
                      ) : (
                        <LuBan className="h-3.5 w-3.5" />
                      )}
                    </IconButton>
                  )}
                  {isAdmin && (
                    <IconButton
                      label={`Delete ${cycle.name}`}
                      size="sm"
                      onClick={() => {
                        void remove(cycle.cycle_id).catch(() => undefined);
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

export default Cycles;
