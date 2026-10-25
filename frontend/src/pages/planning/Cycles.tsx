/**
 * One team's cycles. A cycle's status is derived by the server from its dates,
 * so this page never offers a status control on a row: it offers the dates,
 * and it offers cancelling, which is the one piece of state the dates cannot
 * imply.
 *
 * The current cycle leads, because it is the one a person is working in and
 * the only one whose remaining days matter. Upcoming follows it, and
 * everything finished collapses into a section that stays shut until asked
 * for. Every cycle opens its own page with the burn-up and the issues.
 * J and K, or the arrow keys, move a highlight through the current cycle and
 * the rows of every open group in the order they are drawn, and Enter opens
 * the highlighted cycle.
 *
 * Every cycle row and the current cycle's card carry a `...` menu with
 * "Edit cycle..." for the name, goal and dates, cancel or restore, and
 * delete. The next upcoming cycle's menu also offers "Start cycle today",
 * which ends the current cycle yesterday and moves its open issues across,
 * behind a confirm that names the cycle and the count, and the current
 * cycle's offers "End cycle today", behind a confirm that its unfinished
 * issues roll into the next cycle and that it cannot be undone. An edit or a
 * cancel shows at once and offers Undo once it lands.
 *
 * Where the dates leave days with no cycle, a muted "Cycles paused" row sits
 * between the cycles, read from the server's gap field. Each upcoming row
 * carries a capacity dial: how much of the last three cycles' velocity the
 * cycle already holds.
 *
 * The header's `...` menu offers "Subscribe to cycle calendar", a private
 * feed URL that puts the team's cycles in a calendar app as all-day events.
 *
 * Velocity sits under the current cycle: what the last closed cycles
 * delivered and how the cycle being planned compares with that average.
 *
 * A parent team's cycles roll up its visible sub-teams' matching cycles, so
 * their counts and progress include the sub-teams' issues, with the same
 * toggle as the issue list to show the team alone.
 *
 * A team with no cycles offers Create cycle, with its shortcut, to anyone who
 * may write, and a team whose automatic cycles are turned off says so and
 * links an admin to the team's cycle settings instead.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  LuBan,
  LuCalendarPlus,
  LuChevronRight,
  LuCalendarCheck,
  LuEllipsis,
  LuLayers,
  LuPause,
  LuPencil,
  LuPlay,
  LuPlus,
  LuRotateCcw,
  LuTrash2,
} from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createCycle,
  deleteCycle,
  endCycleToday,
  getVelocity,
  listCycles,
  startCycleToday,
  updateCycle,
} from '../../api/planning';
import { getCycleSettings } from '../../api/teams';
import { ErrorAlert } from '../../components/ui/alert';
import Badge, { type BadgeTone } from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState, { EmptyStateButton } from '../../components/ui/empty-state';
import TextLink from '../../components/ui/link';
import Field from '../../components/ui/field';
import Menu, { MenuItem, MenuSeparator } from '../../components/ui/menu';
import Spinner from '../../components/ui/spinner';
import CapacityDial from '../../components/planning/CapacityDial';
import CycleCalendarDialog from '../../components/planning/CycleCalendarDialog';
import EditCycleDialog from '../../components/planning/EditCycleDialog';
import ProgressBar from '../../components/planning/ProgressBar';
import ProgressRing from '../../components/planning/ProgressRing';
import VelocityPanel from '../../components/planning/VelocityPanel';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import SubTeamToggle from '../../components/workspace/SubTeamToggle';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useShortcut } from '../../hooks/useShortcuts';
import { useSubTeamRollUp } from '../../hooks/useSubTeamRollUp';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { cycleTitle } from '../../lib/cycleBreakdown';
import { readRolledUpCycles, rollUpCycles } from '../../lib/cycleRollUp';
import { errorMessage } from '../../lib/errors';
import {
  CYCLE_STATUS_LABELS,
  completionPercent,
  countsLabel,
  cycleDatesLabel,
  daysRemainingLabel,
  shortCountsLabel,
} from '../../lib/planningDisplay';
import { cyclePath, teamSettingsSectionPath } from '../../lib/paths';
import {
  cycleCapacity,
  cycleEntries,
  pausedLabel,
  type CycleCapacity,
  type CycleEdit,
} from '../../lib/planningModel';
import { cycleSettingsKey, cyclesKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import { validateCycleDates } from '../../lib/validation';
import type {
  CycleListRead,
  CycleRead,
  CycleStatus,
  VelocityRead,
} from '../../types/Api';

/** How often the list re-reads. */
const POLL_MS = 60000;

/** The badge tint each cycle status takes. */
const STATUS_TONES: Record<CycleStatus, BadgeTone> = {
  upcoming: 'neutral',
  active: 'accent',
  completed: 'success',
  cancelled: 'danger',
};

/** Props for CycleRow: one cycle, where it opens and what the caller may do. */
interface CycleRowProps {
  cycle: CycleRead;
  href: string;
  canEdit: boolean;
  isAdmin: boolean;
  onEdit: (cycle: CycleRead) => void;
  onCancel: (cycle: CycleRead) => void;
  onDelete: (cycle: CycleRead) => void;
  onStartToday?: ((cycle: CycleRead) => void) | undefined;
  /** The cycle's capacity dial, drawn only for one that has not started. */
  capacity?: CycleCapacity | null;
  isActive: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onPointerEnter: () => void;
}

/** Props for CycleMenu: one cycle and what the caller may do to it. */
interface CycleMenuProps {
  cycle: CycleRead;
  canEdit: boolean;
  isAdmin: boolean;
  onEdit: (cycle: CycleRead) => void;
  onCancel: (cycle: CycleRead) => void;
  onDelete: (cycle: CycleRead) => void;
  /** Present only on the next upcoming cycle, the one that may start today. */
  onStartToday?: ((cycle: CycleRead) => void) | undefined;
  /** Present only on the current cycle, the one that may end today. */
  onEndToday?: ((cycle: CycleRead) => void) | undefined;
}

/**
 * The `...` menu for one cycle: edit, start or end today, cancel or restore,
 * and delete.
 * Shared by the rows and the active card, because the running cycle is the
 * one most likely to need cancelling and must not lose the actions by being
 * promoted. Draws nothing for a caller who may do none of them.
 */
const CycleMenu: React.FC<CycleMenuProps> = ({
  cycle,
  canEdit,
  isAdmin,
  onEdit,
  onCancel,
  onDelete,
  onStartToday,
  onEndToday,
}) => {
  if (!canEdit && !isAdmin) return null;
  const title = cycleTitle(cycle);
  return (
    <Menu
      label={`${title} actions`}
      align="end"
      trigger={(trigger) => (
        <IconButton label={`${title} actions`} size="sm" {...trigger}>
          <LuEllipsis className="h-3.5 w-3.5" />
        </IconButton>
      )}
    >
      {canEdit && (
        <MenuItem
          onSelect={() => {
            onEdit(cycle);
          }}
        >
          <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
          Edit cycle...
        </MenuItem>
      )}
      {canEdit && onStartToday !== undefined && (
        <MenuItem
          onSelect={() => {
            onStartToday(cycle);
          }}
        >
          <LuPlay aria-hidden="true" className="h-3.5 w-3.5" />
          Start cycle today
        </MenuItem>
      )}
      {canEdit && onEndToday !== undefined && (
        <MenuItem
          onSelect={() => {
            onEndToday(cycle);
          }}
        >
          <LuCalendarCheck aria-hidden="true" className="h-3.5 w-3.5" />
          End cycle today
        </MenuItem>
      )}
      {canEdit && (
        <MenuItem
          onSelect={() => {
            onCancel(cycle);
          }}
        >
          {cycle.cancelled ? (
            <LuRotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <LuBan aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {cycle.cancelled ? 'Restore cycle' : 'Cancel cycle'}
        </MenuItem>
      )}
      {isAdmin && (
        <>
          {canEdit && <MenuSeparator />}
          <MenuItem
            danger
            onSelect={() => {
              onDelete(cycle);
            }}
          >
            <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
            Delete cycle
          </MenuItem>
        </>
      )}
    </Menu>
  );
};

/** How many issues starting a cycle today moves out of the current one. */
const movingCount = (current: CycleRead | undefined): number =>
  current === undefined ? 0 : current.counts.todo + current.counts.in_progress;

/** The confirm sentence for starting a cycle today. */
const startTodayMessage = (
  cycle: CycleRead,
  current: CycleRead | undefined
): string => {
  const title = cycleTitle(cycle);
  if (current === undefined) return `${title} will start today.`;
  const count = movingCount(current);
  const issues = count === 1 ? '1 open issue' : `${String(count)} open issues`;
  return `${title} will start today and ${cycleTitle(current)} will end yesterday. ${issues} will move from ${cycleTitle(current)} into ${title}.`;
};

/** The confirm sentence for ending the current cycle today. */
const endTodayMessage = (cycle: CycleRead): string => {
  const count = movingCount(cycle);
  const issues =
    count === 0
      ? 'Any unfinished issues'
      : count === 1
        ? 'Its 1 unfinished issue'
        : `Its ${String(count)} unfinished issues`;
  return `${cycleTitle(cycle)} will end at the close of today. ${issues} will roll into the next cycle. This cannot be undone.`;
};

/** A muted row for the days between two cycles that no cycle covers. */
const PausedRow: React.FC<{ days: number }> = ({ days }) => (
  <li
    className="flex h-8 items-center gap-3 border-b border-line bg-bg px-3 text-xs text-text-faint last:border-b-0"
    data-testid="cycles-paused"
  >
    <LuPause aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
    <span className="tabular-nums">{pausedLabel(days)}</span>
  </li>
);

/** One cycle as a dense row that opens its page, in the upcoming and past lists. */
const CycleRow: React.FC<CycleRowProps> = ({
  cycle,
  href,
  canEdit,
  isAdmin,
  onEdit,
  onCancel,
  onDelete,
  onStartToday,
  capacity = null,
  isActive,
  rowRef,
  onPointerEnter,
}) => {
  const percent = completionPercent(cycle.counts);
  return (
    <li
      ref={rowRef}
      onPointerEnter={onPointerEnter}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'group/row relative flex h-11 items-center gap-3 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface has-[a:active]:bg-raised',
        isActive &&
          'bg-surface before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
      )}
    >
      <Link
        to={href}
        aria-label={cycleTitle(cycle)}
        data-hover="parent"
        className="absolute inset-0 rounded-md focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <ProgressRing percent={percent} size={16} />
      <span className="pointer-events-none min-w-0 flex-1 truncate text-sm font-medium">
        {cycleTitle(cycle)}
        {cycle.goal !== null && (
          <span className="ml-2 hidden font-normal text-text-faint lg:inline">
            {cycle.goal}
          </span>
        )}
      </span>
      {cycle.status === 'cancelled' && (
        <Badge tone={STATUS_TONES[cycle.status]}>
          {CYCLE_STATUS_LABELS[cycle.status]}
        </Badge>
      )}
      {capacity !== null && (
        <span className="relative z-10 flex shrink-0 items-center">
          <CapacityDial capacity={capacity} />
        </span>
      )}
      <span className="pointer-events-none shrink-0 text-xs whitespace-nowrap text-text-muted tabular-nums">
        {cycleDatesLabel(cycle.start_date, cycle.end_date)}
      </span>
      <span className="pointer-events-none hidden w-24 shrink-0 text-right text-xs text-text-muted tabular-nums md:block">
        {`${shortCountsLabel(cycle.counts)} · ${String(percent)}%`}
      </span>
      <span className="relative z-10 flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100">
        <CycleMenu
          cycle={cycle}
          canEdit={canEdit}
          isAdmin={isAdmin}
          onEdit={onEdit}
          onCancel={onCancel}
          onDelete={onDelete}
          onStartToday={onStartToday}
        />
      </span>
    </li>
  );
};

/** Props for ActiveCycle: the running cycle, given its own card. */
type ActiveCycleProps = Omit<CycleMenuProps, 'onStartToday'> & {
  href: string;
  isActive: boolean;
  cardRef: (node: HTMLElement | null) => void;
  onPointerEnter: () => void;
};

/** The running cycle, shown in full rather than as a row. */
const ActiveCycle: React.FC<ActiveCycleProps> = ({
  cycle,
  href,
  canEdit,
  isAdmin,
  onEdit,
  onCancel,
  onDelete,
  onEndToday,
  isActive,
  cardRef,
  onPointerEnter,
}) => {
  const percent = completionPercent(cycle.counts);
  return (
    <section
      ref={cardRef}
      onPointerEnter={onPointerEnter}
      aria-label="Current cycle"
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'rounded-md border border-line bg-surface p-4 transition-colors duration-100',
        isActive && 'border-accent ring-1 ring-accent'
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">
          <Link
            to={href}
            className="rounded-xs hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {cycleTitle(cycle)}
          </Link>
        </h2>
        <Badge tone="accent">Current</Badge>
        <span className="text-xs text-text-muted tabular-nums">
          {cycleDatesLabel(cycle.start_date, cycle.end_date)}
        </span>
        <span className="text-xs font-medium text-text tabular-nums">
          {daysRemainingLabel(cycle.end_date)}
        </span>
        <span className="ml-auto flex items-center gap-1 self-center">
          <CycleMenu
            cycle={cycle}
            canEdit={canEdit}
            isAdmin={isAdmin}
            onEdit={onEdit}
            onCancel={onCancel}
            onDelete={onDelete}
            onEndToday={onEndToday}
          />
        </span>
      </div>

      {cycle.goal !== null && (
        <p className="mt-2 text-sm text-text-muted">{cycle.goal}</p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <ProgressBar percent={percent} className="min-w-0 flex-1" />
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
  hrefFor: (cycle: CycleRead) => string;
  isOpen: boolean;
  onToggle: () => void;
  canEdit: boolean;
  isAdmin: boolean;
  onEdit: (cycle: CycleRead) => void;
  onCancel: (cycle: CycleRead) => void;
  onDelete: (cycle: CycleRead) => void;
  /** Whether the rows read oldest first, or newest first as the past does. */
  order?: 'ascending' | 'descending';
  /** The cycle after the group, whose paused days lead a descending list. */
  after?: CycleRead | undefined;
  /** The team's velocity, for the capacity dial on a cycle not yet started. */
  velocity?: VelocityRead | null;
  /** The one cycle of the group that may start today, if any. */
  startableId?: string | null;
  onStartToday?: ((cycle: CycleRead) => void) | undefined;
  /** The keyboard position of the group's first row. */
  start: number;
  activeIndex: number;
  registerItem: (index: number) => (node: HTMLElement | null) => void;
  setActiveIndex: (index: number) => void;
}

/**
 * One named group of cycles, collapsible so a long past does not fill the
 * page. The page holds whether it is open, so a folded group's rows drop out
 * of the keyboard order.
 */
const CycleGroup: React.FC<CycleGroupProps> = ({
  title,
  cycles,
  hrefFor,
  isOpen,
  onToggle,
  canEdit,
  isAdmin,
  onEdit,
  onCancel,
  onDelete,
  order = 'ascending',
  after,
  velocity = null,
  startableId = null,
  onStartToday,
  start,
  activeIndex,
  registerItem,
  setActiveIndex,
}) => {
  if (cycles.length === 0) return null;
  const entries = cycleEntries(cycles, order, after);
  const positions = new Map(
    cycles.map((cycle, index) => [cycle.cycle_id, start + index])
  );

  return (
    <section>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={onToggle}
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
          {entries.map((entry) => {
            if (entry.kind === 'gap') {
              return <PausedRow key={entry.key} days={entry.days} />;
            }
            const { cycle } = entry;
            const position = positions.get(cycle.cycle_id) ?? start;
            return (
              <CycleRow
                key={cycle.cycle_id}
                cycle={cycle}
                href={hrefFor(cycle)}
                canEdit={canEdit}
                isAdmin={isAdmin}
                onEdit={onEdit}
                onCancel={onCancel}
                onDelete={onDelete}
                onStartToday={
                  cycle.cycle_id === startableId ? onStartToday : undefined
                }
                capacity={
                  velocity === null ? null : cycleCapacity(velocity, cycle)
                }
                isActive={position === activeIndex}
                rowRef={registerItem(position)}
                onPointerEnter={() => {
                  setActiveIndex(position);
                }}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
};

/** The cycles of the team named by the route's key prefix. */
export const Cycles: React.FC = () => {
  const { keyPrefix, slug } = useParams<{ slug: string; keyPrefix: string }>();
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const {
    team,
    workspaceId,
    isLoading: isResolving,
    notFound,
    error: teamsError,
  } = useTeam(keyPrefix);

  const [isCreating, setIsCreating] = useState(false);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [goal, setGoal] = useState('');
  const [isUpcomingOpen, setIsUpcomingOpen] = useState(true);
  const [isPastOpen, setIsPastOpen] = useState(false);
  const [starting, setStarting] = useState<CycleRead | null>(null);
  const [ending, setEnding] = useState<CycleRead | null>(null);
  const [editing, setEditing] = useState<CycleRead | null>(null);
  const [overlay, setOverlay] = useState<Record<string, Partial<CycleRead>>>(
    {}
  );

  const teamId = team?.id ?? '';
  const { subTeams, rollUp, toggle } = useSubTeamRollUp(team);
  const subTeamIds = useMemo(
    () => subTeams.map((other) => other.id),
    [subTeams]
  );
  const queryKey = cyclesKey(workspaceId, teamId, rollUp ? 'sub-teams' : '');

  const read = useCallback(
    async ({ signal }: { signal?: AbortSignal }): Promise<CycleListRead> => {
      if (!rollUp) return listCycles(workspaceId, { team_id: teamId }, signal);
      const rows = await readRolledUpCycles(workspaceId, teamId, signal);
      return {
        cycles: rollUpCycles(teamId, rows, subTeamIds),
        next_cursor: null,
      };
    },
    [workspaceId, teamId, rollUp, subTeamIds]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: teamId !== '',
    queryKey,
    auth,
  });

  const readVelocity = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getVelocity(workspaceId, teamId, undefined, signal),
    [workspaceId, teamId]
  );
  const { data: velocity } = usePolledQuery(readVelocity, {
    intervalMs: POLL_MS,
    enabled: teamId !== '',
    queryKey: ['cycleVelocity', workspaceId, teamId],
    auth,
  });

  const readCycleSettings = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getCycleSettings(workspaceId, teamId, signal),
    [workspaceId, teamId]
  );
  const { data: cycleSettings } = usePolledQuery(readCycleSettings, {
    intervalMs: POLL_MS,
    enabled: teamId !== '' && !isLoading && (data?.cycles.length ?? 0) === 0,
    queryKey: cycleSettingsKey(workspaceId, teamId),
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

  const { mutate: edit } = useMutationWithRefetch(
    (cycleId: string, patch: CycleEdit) =>
      updateCycle(workspaceId, cycleId, { team_id: teamId, ...patch }),
    queryKey
  );

  const {
    mutate: endToday,
    isMutating: isEnding,
    error: endError,
  } = useMutationWithRefetch(
    (cycleId: string) => endCycleToday(workspaceId, cycleId, teamId),
    queryKey
  );

  const optimistic = useCallback(
    async <T,>(
      cycleId: string,
      fields: Partial<CycleRead>,
      run: () => Promise<T>
    ): Promise<T> => {
      setOverlay((held) => ({ ...held, [cycleId]: fields }));
      try {
        return await run();
      } finally {
        setOverlay((held) => {
          return Object.fromEntries(
            Object.entries(held).filter(([key]) => key !== cycleId)
          );
        });
      }
    },
    []
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (cycleId: string) => deleteCycle(workspaceId, cycleId, teamId),
    queryKey
  );

  const {
    mutate: startToday,
    isMutating: isStarting,
    error: startError,
  } = useMutationWithRefetch(
    (cycleId: string) => startCycleToday(workspaceId, cycleId, teamId),
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
      const cancelled = !cycle.cancelled;
      const title = cycleTitle(cycle);
      void optimistic(
        cycle.cycle_id,
        {
          cancelled,
          status: cancelled
            ? 'cancelled'
            : cycle.status === 'cancelled'
              ? 'upcoming'
              : cycle.status,
        },
        () => setCancelled(cycle.cycle_id, cancelled)
      )
        .then(() => {
          showToast(
            `${title} ${cancelled ? 'cancelled' : 'restored'}`,
            'info',
            {
              action: {
                label: 'Undo',
                run: () => {
                  void setCancelled(cycle.cycle_id, !cancelled).catch(() => {
                    showErrorToast('Could not undo that change.');
                  });
                },
              },
            }
          );
        })
        .catch(() => undefined);
    },
    [setCancelled, optimistic]
  );

  const onEdit = useCallback((cycle: CycleRead): void => {
    setEditing(cycle);
  }, []);

  const saveEdit = useCallback(
    async (cycle: CycleRead, patch: CycleEdit, before: CycleEdit) => {
      const shown: Partial<CycleRead> = {};
      if (patch.name !== undefined) shown.name = patch.name;
      if (patch.goal !== undefined) shown.goal = patch.goal;
      await optimistic(cycle.cycle_id, shown, () =>
        edit(cycle.cycle_id, patch)
      );
      showToast(`${cycleTitle({ ...cycle, ...shown })} updated`, 'info', {
        action: {
          label: 'Undo',
          run: () => {
            void edit(cycle.cycle_id, before).catch((failure: unknown) => {
              showErrorToast(
                errorMessage(failure, 'Could not undo that edit.')
              );
            });
          },
        },
      });
    },
    [edit, optimistic]
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

  const cycles = useMemo(
    () =>
      (data?.cycles ?? []).map((row) => {
        const fields = overlay[row.cycle_id];
        return fields === undefined ? row : { ...row, ...fields };
      }),
    [data, overlay]
  );
  const { active, upcoming, past } = useMemo(
    () => ({
      active: cycles.filter((row) => row.status === 'active'),
      upcoming: cycles.filter((row) => row.status === 'upcoming'),
      past: cycles
        .filter(
          (row) => row.status === 'completed' || row.status === 'cancelled'
        )
        .reverse(),
    }),
    [cycles]
  );
  const current = active[0];
  const startable =
    !rollUp && upcoming[0]?.team_id === teamId ? upcoming[0] : undefined;
  const onStartToday = useCallback((cycle: CycleRead): void => {
    setStarting(cycle);
  }, []);
  const closeStart = useCallback((): void => {
    setStarting(null);
  }, []);
  const onEndToday = useCallback((cycle: CycleRead): void => {
    setEnding(cycle);
  }, []);
  const closeEnd = useCallback((): void => {
    setEnding(null);
  }, []);
  const visible = useMemo(
    () => [
      ...active,
      ...(isUpcomingOpen ? upcoming : []),
      ...(isPastOpen ? past : []),
    ],
    [active, upcoming, past, isUpcomingOpen, isPastOpen]
  );
  const teamPrefix = team?.key_prefix ?? '';
  const hrefFor = useCallback(
    (cycle: CycleRead): string =>
      cyclePath(slug ?? '', teamPrefix, cycle.cycle_id),
    [slug, teamPrefix]
  );
  const onActivate = useCallback(
    (index: number): void => {
      const cycle = visible[index];
      if (cycle !== undefined) void navigate(hrefFor(cycle));
    },
    [visible, navigate, hrefFor]
  );
  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: visible.length,
    onActivate,
    resetKey: visible.map((row) => row.cycle_id).join(','),
    enabled:
      !isCreating &&
      !isSubscribing &&
      starting === null &&
      ending === null &&
      editing === null,
  });

  useShortcut({
    keys: 'shift+n',
    label: 'New cycle',
    group: 'Cycles',
    enabled: canEdit && team !== null && !isCreating,
    handler: (event) => {
      event?.preventDefault();
      setIsCreating(true);
    },
  });

  if (isResolving) {
    return (
      <WorkspaceShell title="Cycles">
        {teamsError !== null && (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load this team.')}
          />
        )}
        <Spinner label="Loading cycles" />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null) {
    return (
      <WorkspaceShell title="Cycles">
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <div className="flex items-center gap-2">
          <TeamTabs
            slug={slug ?? ''}
            keyPrefix={team.key_prefix}
            teamId={team.id}
            current="cycles"
          />
          {subTeams.length > 0 && (
            <SubTeamToggle rollUp={rollUp} onToggle={toggle} />
          )}
        </div>
      }
      actions={
        <div className="flex items-center gap-2">
          <Menu
            label="Cycles options"
            align="end"
            trigger={(trigger) => (
              <IconButton label="Cycles options" {...trigger}>
                <LuEllipsis className="h-4 w-4" />
              </IconButton>
            )}
          >
            <MenuItem
              onSelect={() => {
                setIsSubscribing(true);
              }}
            >
              <LuCalendarPlus aria-hidden="true" className="h-3.5 w-3.5" />
              Subscribe to cycle calendar
            </MenuItem>
          </Menu>
          {canEdit && (
            <Button
              variant="primary"
              onClick={() => {
                setIsCreating(true);
              }}
            >
              <LuPlus aria-hidden="true" />
              New cycle
            </Button>
          )}
        </div>
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
          <Spinner label="Loading cycles" />
        ) : cycles.length === 0 ? (
          cycleSettings?.enabled === false ? (
            <EmptyState
              icon={<LuLayers />}
              message="Cycles are turned off for this team."
              action={
                isAdmin && team !== null ? (
                  <TextLink
                    to={teamSettingsSectionPath(
                      slug ?? '',
                      team.key_prefix,
                      'cycles'
                    )}
                    className="text-sm"
                  >
                    Turn on cycles in team settings
                  </TextLink>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              icon={<LuLayers />}
              message="No cycles yet. A cycle is a dated run of work for this team."
              action={
                canEdit && team !== null ? (
                  <EmptyStateButton
                    label="Create cycle"
                    keys="shift+n"
                    onClick={() => {
                      setIsCreating(true);
                    }}
                  />
                ) : undefined
              }
            />
          )
        ) : (
          <>
            {active.map((cycle, index) => (
              <ActiveCycle
                key={cycle.cycle_id}
                cycle={cycle}
                href={hrefFor(cycle)}
                canEdit={canEdit}
                isAdmin={isAdmin}
                onEdit={onEdit}
                onCancel={onCancel}
                onDelete={onDelete}
                onEndToday={
                  !rollUp || cycle.team_id === teamId ? onEndToday : undefined
                }
                isActive={index === activeIndex}
                cardRef={registerItem(index)}
                onPointerEnter={() => {
                  setActiveIndex(index);
                }}
              />
            ))}
            {velocity !== null && velocity !== undefined && (
              <VelocityPanel velocity={velocity} />
            )}
            <CycleGroup
              title="Upcoming"
              cycles={upcoming}
              startableId={startable?.cycle_id ?? null}
              onStartToday={onStartToday}
              velocity={velocity ?? null}
              hrefFor={hrefFor}
              isOpen={isUpcomingOpen}
              onToggle={() => {
                setIsUpcomingOpen((held) => !held);
              }}
              start={active.length}
              activeIndex={activeIndex}
              registerItem={registerItem}
              setActiveIndex={setActiveIndex}
              canEdit={canEdit}
              isAdmin={isAdmin}
              onEdit={onEdit}
              onCancel={onCancel}
              onDelete={onDelete}
            />
            <CycleGroup
              title="Past"
              cycles={past}
              order="descending"
              after={current}
              hrefFor={hrefFor}
              isOpen={isPastOpen}
              onToggle={() => {
                setIsPastOpen((held) => !held);
              }}
              start={active.length + (isUpcomingOpen ? upcoming.length : 0)}
              activeIndex={activeIndex}
              registerItem={registerItem}
              setActiveIndex={setActiveIndex}
              canEdit={canEdit}
              isAdmin={isAdmin}
              onEdit={onEdit}
              onCancel={onCancel}
              onDelete={onDelete}
            />
          </>
        )}
      </div>

      {starting !== null && (
        <Dialog open title="Start cycle today" onClose={closeStart} size="sm">
          <div className="space-y-4">
            {startError !== null && (
              <ErrorAlert
                message={errorMessage(
                  startError,
                  'Could not start that cycle.'
                )}
              />
            )}
            <p className="text-sm text-text-muted">
              {startTodayMessage(starting, current)}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeStart}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={isStarting}
                onClick={() => {
                  void startToday(starting.cycle_id)
                    .then(() => {
                      setStarting(null);
                    })
                    .catch(() => undefined);
                }}
              >
                {isStarting ? 'Starting' : `Start ${cycleTitle(starting)}`}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {ending !== null && (
        <Dialog open title="End cycle today" onClose={closeEnd} size="sm">
          <div className="space-y-4">
            {endError !== null && (
              <ErrorAlert
                message={errorMessage(endError, 'Could not end that cycle.')}
              />
            )}
            <p className="text-sm text-text-muted">{endTodayMessage(ending)}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeEnd}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={isEnding}
                onClick={() => {
                  void endToday(ending.cycle_id)
                    .then(() => {
                      setEnding(null);
                    })
                    .catch(() => undefined);
                }}
              >
                {isEnding ? 'Ending' : `End ${cycleTitle(ending)} today`}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {editing !== null && (
        <EditCycleDialog
          cycle={editing}
          onSave={(patch, before) => saveEdit(editing, patch, before)}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}

      {isSubscribing && (
        <CycleCalendarDialog
          workspaceId={workspaceId}
          teamId={team.id}
          teamName={team.name}
          onClose={() => {
            setIsSubscribing(false);
          }}
        />
      )}

      {isCreating && (
        <Dialog open title="New cycle" onClose={closeDialog}>
          <div className="space-y-4">
            {addError !== null && (
              <ErrorAlert
                message={errorMessage(addError, 'Could not create that cycle.')}
              />
            )}
            <Field
              id="new-cycle-name"
              label="Name"
              placeholder="Name this cycle"
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
