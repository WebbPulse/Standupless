/**
 * One team's cycles. A cycle's status is derived by the server from its dates,
 * so this page never offers a status control on a row: it offers the dates,
 * and it offers cancelling, which is the one piece of state the dates cannot
 * imply.
 *
 * The active cycle leads, because it is the one a person is working in and the
 * only one whose remaining days matter. Upcoming follows it, and everything
 * finished collapses into a section that stays shut until asked for.
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
  LuPlus,
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
import { ErrorAlert } from '../../components/ui/alert';
import Badge, { type BadgeTone } from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Field from '../../components/ui/field';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import {
  CYCLE_STATUS_LABELS,
  completionPercent,
  countsLabel,
  cycleDatesLabel,
  daysRemainingLabel,
  shortCountsLabel,
} from '../../lib/planningDisplay';
import { cyclesKey } from '../../lib/queryKeys';
import { validateCycleDates } from '../../lib/validation';
import type { CycleRead, CycleStatus } from '../../types/Api';

/** How often the list re-reads. */
const POLL_MS = 60000;

/** The badge tint each cycle status takes. */
const STATUS_TONES: Record<CycleStatus, BadgeTone> = {
  upcoming: 'neutral',
  active: 'accent',
  completed: 'success',
  cancelled: 'danger',
};

/** Props for Progress: how far through its issues a cycle is. */
interface ProgressProps {
  percent: number;
  className?: string;
}

/** The filled bar a cycle's completion reads off. */
const Progress: React.FC<ProgressProps> = ({ percent, className }) => (
  <span
    aria-hidden="true"
    className={cn(
      'block h-1.5 overflow-hidden rounded-full bg-accent-soft',
      className
    )}
  >
    <span
      className="block h-full rounded-full bg-accent transition-[width] duration-200"
      style={{ width: `${String(percent)}%` }}
    />
  </span>
);

/** Props for CycleRow: one cycle and what the caller may do to it. */
interface CycleRowProps {
  cycle: CycleRead;
  canEdit: boolean;
  isAdmin: boolean;
  onCancel: (cycle: CycleRead) => void;
  onDelete: (cycle: CycleRead) => void;
}

/** One cycle as a dense row, in the upcoming and past lists. */
const CycleRow: React.FC<CycleRowProps> = ({
  cycle,
  canEdit,
  isAdmin,
  onCancel,
  onDelete,
}) => (
  <li className="flex h-row items-center gap-3 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface">
    <LuLayers className="h-4 w-4 shrink-0 text-text-faint" aria-hidden="true" />
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
    <Progress
      percent={completionPercent(cycle.counts)}
      className="hidden w-20 shrink-0 md:block"
    />
    <span className="hidden shrink-0 text-xs text-text-muted tabular-nums md:block">
      {shortCountsLabel(cycle.counts)}
    </span>
    {canEdit && (
      <IconButton
        label={
          cycle.cancelled ? `Restore ${cycle.name}` : `Cancel ${cycle.name}`
        }
        size="sm"
        onClick={() => {
          onCancel(cycle);
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
          onDelete(cycle);
        }}
      >
        <LuTrash2 className="h-3.5 w-3.5" />
      </IconButton>
    )}
  </li>
);

/** Props for ActiveCycle: the running cycle, given its own card. */
interface ActiveCycleProps {
  cycle: CycleRead;
}

/** The running cycle, shown in full rather than as a row. */
const ActiveCycle: React.FC<ActiveCycleProps> = ({ cycle }) => {
  const percent = completionPercent(cycle.counts);
  return (
    <section
      aria-label={'Active cycle'}
      className="rounded-md border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{cycle.name}</h2>
        <Badge tone="accent">{CYCLE_STATUS_LABELS.active}</Badge>
        <span className="text-xs text-text-muted tabular-nums">
          {cycleDatesLabel(cycle.start_date, cycle.end_date)}
        </span>
        <span className="text-xs font-medium text-text tabular-nums">
          {daysRemainingLabel(cycle.end_date)}
        </span>
      </div>

      {cycle.goal !== null && (
        <p className="mt-2 text-sm text-text-muted">{cycle.goal}</p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <Progress percent={percent} className="min-w-0 flex-1" />
        <span className="shrink-0 text-xs font-medium tabular-nums">
          {String(percent)}%
        </span>
      </div>
      <p className="mt-1.5 text-xs text-text-muted tabular-nums">
        {countsLabel(cycle.counts)}
      </p>
    </section>
  );
};

/** Props for CycleGroup: a named list of cycles that can be folded away. */
interface CycleGroupProps {
  title: string;
  cycles: CycleRead[];
  defaultOpen: boolean;
  canEdit: boolean;
  isAdmin: boolean;
  onCancel: (cycle: CycleRead) => void;
  onDelete: (cycle: CycleRead) => void;
}

/** One named group of cycles, collapsible so a long past does not fill the page. */
const CycleGroup: React.FC<CycleGroupProps> = ({
  title,
  cycles,
  defaultOpen,
  canEdit,
  isAdmin,
  onCancel,
  onDelete,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  if (cycles.length === 0) return null;

  return (
    <section>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((held) => !held);
        }}
        className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text-muted transition-colors duration-100 hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        <LuChevronRight
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-100',
            isOpen && 'rotate-90'
          )}
        />
        {title}
        <span className="text-text-faint tabular-nums">
          {String(cycles.length)}
        </span>
      </button>
      {isOpen && (
        <ul className="rounded-md border border-line">
          {cycles.map((cycle) => (
            <CycleRow
              key={cycle.cycle_id}
              cycle={cycle}
              canEdit={canEdit}
              isAdmin={isAdmin}
              onCancel={onCancel}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

/** The cycles of the team named by the route's key prefix. */
export const Cycles: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ slug: string; keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const {
    team,
    workspaceId,
    isLoading: isResolving,
    notFound,
  } = useTeam(keyPrefix);

  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [goal, setGoal] = useState('');

  const teamId = team?.id ?? '';
  const queryKey = cyclesKey(workspaceId, teamId, '');

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listCycles(workspaceId, { team_id: teamId }, signal),
    [workspaceId, teamId]
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

  const onCancel = useCallback(
    (cycle: CycleRead): void => {
      void setCancelled(cycle.cycle_id, !cycle.cancelled).catch(
        () => undefined
      );
    },
    [setCancelled]
  );

  const onDelete = useCallback(
    (cycle: CycleRead): void => {
      void remove(cycle.cycle_id).catch(() => undefined);
    },
    [remove]
  );

  const closeDialog = useCallback((): void => {
    setIsCreating(false);
  }, []);

  if (isResolving) {
    return (
      <WorkspaceShell title="Cycles">
        <Spinner label={'Loading cycles'} />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null) {
    return (
      <WorkspaceShell title="Cycles">
        <EmptyState
          message={'That team does not exist, or you are not a member of it.'}
        />
      </WorkspaceShell>
    );
  }

  const cycles = data?.cycles ?? [];
  const active = cycles.filter((row) => row.status === 'active');
  const upcoming = cycles.filter((row) => row.status === 'upcoming');
  const past = cycles.filter(
    (row) => row.status === 'completed' || row.status === 'cancelled'
  );

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <TeamTabs
          slug={slug ?? ''}
          keyPrefix={team.key_prefix}
          current="cycles"
        />
      }
      actions={
        canEdit ? (
          <Button
            variant="primary"
            onClick={() => {
              setIsCreating(true);
            }}
          >
            <LuPlus aria-hidden="true" />
            New cycle
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-6">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the cycles.')}
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
          <Spinner label={'Loading cycles'} />
        ) : cycles.length === 0 ? (
          <EmptyState
            icon={<LuLayers />}
            message={
              'No cycles yet. A cycle is a dated run of work for this team.'
            }
          />
        ) : (
          <>
            {active.map((cycle) => (
              <ActiveCycle key={cycle.cycle_id} cycle={cycle} />
            ))}
            <CycleGroup
              title="Upcoming"
              cycles={upcoming}
              defaultOpen
              canEdit={canEdit}
              isAdmin={isAdmin}
              onCancel={onCancel}
              onDelete={onDelete}
            />
            <CycleGroup
              title="Past"
              cycles={past}
              defaultOpen={false}
              canEdit={canEdit}
              isAdmin={isAdmin}
              onCancel={onCancel}
              onDelete={onDelete}
            />
          </>
        )}
      </div>

      {isCreating && (
        <Dialog open title={'New cycle'} onClose={closeDialog}>
          <div className="space-y-4">
            {addError !== null && (
              <ErrorAlert
                message={errorMessage(addError, 'Could not create that cycle.')}
              />
            )}
            <Field
              id="new-cycle-name"
              label="Name"
              placeholder={'Name this cycle'}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="new-cycle-start"
                label="Start date"
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                }}
              />
              <Field
                id="new-cycle-end"
                label="End date"
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                }}
              />
            </div>
            <Field
              id="new-cycle-goal"
              label="Goal"
              placeholder="Optional"
              value={goal}
              onChange={(event) => {
                setGoal(event.target.value);
              }}
            />
            <ErrorAlert message={dateError} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeDialog}>
                Cancel
              </Button>
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
                      setIsCreating(false);
                    })
                    .catch(() => undefined);
                }}
              >
                {isAdding ? 'Creating' : 'Create cycle'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default Cycles;
