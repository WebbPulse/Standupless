/**
 * One cycle. The header names the cycle, its state, dates and days left, and
 * its goal, and a cycle that has not started carries the capacity dial its
 * row on the cycles page shows. While the cycle is upcoming or running, a member edits the name,
 * goal and dates in place, each save shown at once and undone with a notice
 * should the write fail; a completed or cancelled cycle reads only. A side
 * panel holds scope against what is started and completed, the burn-up over
 * the cycle's days and a breakdown of the issues by assignee, label, priority and
 * project, and the cycle's issues fill the rest as the same dense list a
 * team's issues use, with its filters, display options and inline editing.
 * On a narrow screen the panel stacks above the list.
 *
 * The burn-up reads the cycle's recorded daily history, in issues or in
 * estimate points, with a projection once a few days are in. While that
 * history is unavailable it falls back to a series read off the issues as
 * they are now, so the chart never goes blank on a slow or older backend.
 *
 * On a parent team the cycle rolls up its visible sub-teams' cycles with the
 * same dates: the header, the burn-up, the breakdown and the issues all cover
 * the same set, with the toolbar's toggle to show the team alone.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { LuChevronRight, LuPlus } from 'react-icons/lu';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  getCycle,
  getCycleHistory,
  getVelocity,
  updateCycle,
} from '../../api/planning';
import { DatePicker } from '../../components/issues/PropertyPickers';
import DisplayMenu from '../../components/issues/view/DisplayMenu';
import {
  FilterButton,
  FilterChips,
  type FilterLogic,
} from '../../components/issues/view/FilterBar';
import IssueListView from '../../components/issues/view/IssueListView';
import CapacityDial from '../../components/planning/CapacityDial';
import CycleProgressPanel from '../../components/planning/CycleProgressPanel';
import EditableText from '../../components/planning/EditableText';
import ProgressRing from '../../components/planning/ProgressRing';
import { ErrorAlert } from '../../components/ui/alert';
import Badge from '../../components/ui/badge';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import SubTeamToggle from '../../components/workspace/SubTeamToggle';
import TeamTabs from '../../components/workspace/TeamTabs';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useIssueCollection } from '../../hooks/useIssueCollection';
import { useIssueContext } from '../../hooks/useIssueContext';
import { useListFolds } from '../../hooks/useListFolds';
import { usePlanningIssues } from '../../hooks/usePlanningIssues';
import { useShortcut } from '../../hooks/useShortcuts';
import { useSubTeamRollUp } from '../../hooks/useSubTeamRollUp';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { cycleTitle, type BreakdownField } from '../../lib/cycleBreakdown';
import {
  matchingCycles,
  mergeCycles,
  mergeHistories,
  readRolledUpCycles,
} from '../../lib/cycleRollUp';
import { errorMessage } from '../../lib/errors';
import { useOptimisticRecord } from '../../lib/optimistic';
import {
  defaultViewState,
  groupFieldsFor,
  filterValuesFor,
  narrowFilters,
  parseViewState,
  sameViewState,
  viewStateQuery,
  writeViewState,
  type ViewState,
} from '../../lib/issueView';
import { teamCyclesPath } from '../../lib/paths';
import { cyclesKey } from '../../lib/queryKeys';
import {
  CYCLE_STATUS_LABELS,
  completionPercent,
  daysRemainingLabel,
} from '../../lib/planningDisplay';
import {
  burnUpSeries,
  cycleCapacity,
  daysBetween,
  historySeries,
  projectCompletion,
  type CycleCapacity,
  type PlanningMeasure,
} from '../../lib/planningModel';
import { shortDateLabel } from '../../lib/propertyOptions';
import { dayValue, todayNumber } from '../../lib/timeline';
import { showErrorToast } from '../../lib/toast';
import { estimateOptionsOf, validateCycleDates } from '../../lib/validation';
import FavoriteButton from '../../components/ui/FavoriteButton';
import type { CycleHistoryRead, CycleRead, CycleUpdate } from '../../types/Api';

/** The fields the cycle page edits in place. */
type CyclePatch = Pick<
  CycleUpdate,
  'name' | 'goal' | 'start_date' | 'end_date'
>;

/** How often the cycle re-reads. */
const POLL_MS = 30000;

/** The settings a cycle's issues open with. */
const CYCLE_VIEW_BASE: ViewState = defaultViewState('list');

/** The breakdown fields, which the side panel can filter the list by. */
const BREAKDOWN_FIELDS: readonly BreakdownField[] = [
  'assignee',
  'label',
  'project',
  'priority',
];

/** Props for CarryOverLine: the cycle whose carry-over is described. */
interface CarryOverLineProps {
  cycle: CycleRead;
  measure: PlanningMeasure;
}

/**
 * What the cycle close moved into and out of this cycle, in one line, or
 * nothing when no work was carried either way.
 */
const CarryOverLine: React.FC<CarryOverLineProps> = ({ cycle, measure }) => {
  const carry = cycle.carry;
  if (carry === undefined) return null;
  const inbound =
    measure === 'points' ? carry.carried_in_points : carry.carried_in;
  const outbound =
    measure === 'points' ? carry.carried_out_points : carry.carried_out;
  if (carry.carried_in === 0 && carry.carried_out === 0) return null;
  const amount = (value: number): string => {
    const noun = measure === 'points' ? 'point' : 'issue';
    return `${String(value)} ${value === 1 ? noun : `${noun}s`}`;
  };
  const parts: string[] = [];
  if (carry.carried_in > 0) {
    parts.push(`${amount(inbound)} rolled over from the previous cycle`);
  }
  if (carry.carried_out > 0) {
    parts.push(`${amount(outbound)} rolled over to the next cycle`);
  }
  return (
    <p
      className="text-xs text-text-muted tabular-nums"
      data-testid="carry-over"
    >
      {parts.join(' · ')}
    </p>
  );
};

/** Props for CycleHeader: the cycle the header describes and how to edit it. */
interface CycleHeaderProps {
  cycle: CycleRead;
  measure: PlanningMeasure;
  canEdit: boolean;
  onUpdate: (patch: CyclePatch) => void;
  /** The capacity dial for a cycle that has not started, or null. */
  capacity?: CycleCapacity | null;
}

/**
 * The name a cycle reads by once its own name is cleared: its number, or the
 * week it starts, the same readable name an automatic cycle carries.
 */
const fallbackCycleName = (cycle: CycleRead): string =>
  cycleTitle({ ...cycle, name: '' });

/**
 * The cycle's title, state, dates and goal. A cycle left with its generated
 * name reads as its number, and a named cycle keeps its number beside it.
 * When the caller may edit, the name and goal edit in place and each date
 * opens a picker that refuses an end before the start.
 */
const CycleHeader: React.FC<CycleHeaderProps> = ({
  cycle,
  measure,
  canEdit,
  onUpdate,
  capacity = null,
}) => {
  const title = cycleTitle(cycle);
  const percent = completionPercent(cycle.counts);
  const isCurrent = cycle.status === 'active';
  const numbered =
    cycle.number !== undefined && cycle.number !== null
      ? `Cycle ${String(cycle.number)}`
      : null;
  const pickDate = (
    field: 'start_date' | 'end_date',
    picked: string | null
  ): void => {
    if (picked === null || picked === cycle[field]) return;
    const start = field === 'start_date' ? picked : cycle.start_date;
    const end = field === 'end_date' ? picked : cycle.end_date;
    const refusal = validateCycleDates(start, end);
    if (refusal !== null) {
      showErrorToast(refusal);
      return;
    }
    onUpdate(
      field === 'start_date' ? { start_date: picked } : { end_date: picked }
    );
  };
  return (
    <header className="space-y-2 border-b border-line px-4 py-4 lg:col-start-1 lg:row-start-1 lg:px-6">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProgressRing percent={percent} />
        <h2
          className="min-w-0 flex-1 truncate text-lg font-semibold text-text"
          data-testid="cycle-title"
        >
          {canEdit ? (
            <EditableText
              label="Cycle name"
              placeholder={fallbackCycleName(cycle)}
              value={title}
              disabled={false}
              className="truncate text-lg font-semibold"
              onSave={(name) => {
                const next = name === '' ? fallbackCycleName(cycle) : name;
                if (next !== title) onUpdate({ name: next });
              }}
            />
          ) : (
            title
          )}
        </h2>
        {numbered !== null && numbered !== title && (
          <span className="shrink-0 text-sm text-text-faint tabular-nums">
            {numbered}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <Badge tone={isCurrent ? 'accent' : 'neutral'}>
          {isCurrent ? 'Current' : CYCLE_STATUS_LABELS[cycle.status]}
        </Badge>
        {capacity !== null && <CapacityDial capacity={capacity} size={16} />}
        {canEdit ? (
          <span className="flex items-center gap-1.5" data-testid="cycle-dates">
            <DatePicker
              variant="chip"
              field="Start date"
              value={cycle.start_date}
              max={cycle.end_date}
              clearable={false}
              validate={(picked) => validateCycleDates(picked, cycle.end_date)}
              onChange={(picked) => {
                pickDate('start_date', picked);
              }}
            />
            <span aria-hidden="true">to</span>
            <DatePicker
              variant="chip"
              field="End date"
              value={cycle.end_date}
              min={cycle.start_date}
              clearable={false}
              validate={(picked) =>
                validateCycleDates(cycle.start_date, picked)
              }
              onChange={(picked) => {
                pickDate('end_date', picked);
              }}
            />
          </span>
        ) : (
          <span className="tabular-nums" data-testid="cycle-dates">
            {`${shortDateLabel(cycle.start_date)} to ${shortDateLabel(cycle.end_date)}`}
          </span>
        )}
        {isCurrent && <span>{daysRemainingLabel(cycle.end_date)}</span>}
        <span className="tabular-nums">{`${String(percent)}% complete`}</span>
      </div>
      {canEdit ? (
        <EditableText
          label="Cycle goal"
          placeholder="Add a cycle goal"
          value={cycle.goal ?? ''}
          disabled={false}
          className="text-sm text-text-muted"
          onSave={(goal) => {
            onUpdate({ goal: goal === '' ? null : goal });
          }}
        />
      ) : (
        cycle.goal !== null &&
        cycle.goal !== '' && (
          <p className="text-sm text-text-muted">{cycle.goal}</p>
        )
      )}
      <CarryOverLine cycle={cycle} measure={measure} />
    </header>
  );
};

/** One cycle's header, progress panel and issues. */
export const CycleDetail: React.FC = () => {
  const { keyPrefix, cycleId } = useParams<{
    keyPrefix: string;
    cycleId: string;
  }>();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const slug = workspace?.slug ?? '';
  const auth = useQueryAuth();
  const {
    team,
    workspaceId,
    isLoading: isResolving,
    notFound,
    error: teamsError,
  } = useTeam(keyPrefix);
  const id = cycleId ?? '';
  const teamId = team?.id ?? '';

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getCycle(workspaceId, id, teamId, signal),
    [workspaceId, id, teamId]
  );
  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: workspaceId !== '' && teamId !== '' && id !== '',
    queryKey: ['cycle', workspaceId, teamId, id],
    auth,
  });
  const { value: optimistic, update } = useOptimisticRecord<
    CycleRead,
    CyclePatch
  >(data ?? null, {
    write: (patch) =>
      updateCycle(workspaceId, id, { team_id: teamId, ...patch }),
    isSame: (left, right) => left.cycle_id === right.cycle_id,
    invalidate: [
      ['cycle', workspaceId, teamId, id],
      cyclesKey(workspaceId, teamId, ''),
    ],
    failureMessage: (failure) =>
      errorMessage(failure, 'Could not update the cycle. It has been undone.'),
  });
  const own: CycleRead | undefined = optimistic ?? undefined;

  const { subTeams, rollUp, toggle } = useSubTeamRollUp(team);
  const subTeamIds = useMemo(
    () => subTeams.map((other) => other.id),
    [subTeams]
  );
  const readMatches = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      readRolledUpCycles(workspaceId, teamId, signal),
    [workspaceId, teamId]
  );
  const { data: matchData } = usePolledQuery(readMatches, {
    intervalMs: POLL_MS,
    enabled: rollUp && own !== undefined,
    queryKey: ['cycleRollUp', workspaceId, teamId],
    auth,
  });
  const matches = useMemo(
    () =>
      rollUp && own !== undefined
        ? matchingCycles(own, matchData ?? [], subTeamIds)
        : [],
    [rollUp, own, matchData, subTeamIds]
  );
  const cycle = useMemo(
    () => (own === undefined ? undefined : mergeCycles(own, matches)),
    [own, matches]
  );
  const matchKey = matches
    .map((row) => `${row.team_id}:${row.cycle_id}`)
    .join(',');

  const readHistory = useCallback(
    async ({ signal }: { signal?: AbortSignal }): Promise<CycleHistoryRead> => {
      const parts = matchKey === '' ? [] : matchKey.split(',');
      const [mine, ...theirs] = await Promise.all([
        getCycleHistory(workspaceId, id, teamId, signal),
        ...parts.map((part) => {
          const [memberId = '', memberCycle = ''] = part.split(':');
          return getCycleHistory(workspaceId, memberCycle, memberId, signal);
        }),
      ]);
      if (theirs.length === 0) return mine;
      return {
        ...mine,
        days: mergeHistories([mine.days, ...theirs.map((row) => row.days)]),
      };
    },
    [workspaceId, id, teamId, matchKey]
  );
  const { data: history, isLoading: isLoadingHistory } = usePolledQuery(
    readHistory,
    {
      intervalMs: POLL_MS,
      enabled:
        workspaceId !== '' &&
        teamId !== '' &&
        id !== '' &&
        cycle !== undefined &&
        cycle.status !== 'upcoming',
      queryKey: ['cycleHistory', workspaceId, teamId, id, matchKey],
      auth,
    }
  );

  const readVelocity = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getVelocity(workspaceId, teamId, undefined, signal),
    [workspaceId, teamId]
  );
  const { data: velocity } = usePolledQuery(readVelocity, {
    intervalMs: POLL_MS,
    enabled: teamId !== '' && cycle?.status === 'upcoming',
    queryKey: ['cycleVelocity', workspaceId, teamId],
    auth,
  });
  const capacity = useMemo(
    () =>
      velocity === null || velocity === undefined || cycle === undefined
        ? null
        : cycleCapacity(velocity, cycle),
    [velocity, cycle]
  );

  const hasPoints =
    (team !== null && team.estimate_scale !== 'off') ||
    (cycle?.points?.total ?? 0) > 0;
  const [chosenMeasure, setChosenMeasure] = useState<PlanningMeasure>('issues');
  const measure: PlanningMeasure = hasPoints ? chosenMeasure : 'issues';

  const listTeams = useMemo(
    () => (team === null ? [] : rollUp ? [team, ...subTeams] : [team]),
    [team, rollUp, subTeams]
  );
  const listTeamIds = useMemo(
    () => listTeams.map((member) => member.id),
    [listTeams]
  );
  const lists = useIssueContext(workspaceId, listTeamIds, user?.id);
  const statuses = lists.context.statuses;

  const cycleIds = useMemo(
    () => [id, ...matches.map((row) => row.cycle_id)],
    [id, matches]
  );
  const issuesKey = [
    'cycleIssues',
    workspaceId,
    teamId,
    id,
    cycleIds.join(','),
  ] as const;
  const issueQuery = useMemo(
    () =>
      cycleIds.length > 1
        ? { team_id: teamId, include_sub_teams: true, cycle_id: cycleIds }
        : { team_id: teamId, cycle_id: id },
    [teamId, id, cycleIds]
  );
  const issuesEnabled = teamId !== '' && id !== '';
  const issues = usePlanningIssues(
    workspaceId,
    issueQuery,
    issuesKey,
    issuesEnabled
  );

  const [params, setParams] = useSearchParams();
  const base = CYCLE_VIEW_BASE;
  const state = useMemo(() => parseViewState(params, base), [params, base]);
  const setState = useCallback(
    (next: ViewState) => {
      setParams(writeViewState(next, base, params), { replace: true });
    },
    [setParams, base, params]
  );
  const folds = useListFolds(
    workspaceId,
    id === '' ? undefined : `cycle:${id}`
  );
  const setFilters = (filters: ViewState['filters']): void => {
    setState({ ...state, filters });
  };
  const setLogic = (logic: FilterLogic): void => {
    setState({ ...state, ...logic });
  };
  const collection = useIssueCollection(
    workspaceId,
    `cycle:${teamId}:${cycleIds.join(',')}`,
    viewStateQuery(state, issueQuery),
    workspaceId !== '' && issuesEnabled
  );

  const activeFilters = useMemo(() => {
    const held: Partial<Record<BreakdownField, string[]>> = {};
    for (const clause of state.filters) {
      if (
        clause.op === 'is' &&
        (BREAKDOWN_FIELDS as readonly string[]).includes(clause.field)
      ) {
        held[clause.field as BreakdownField] = clause.values;
      }
    }
    return held;
  }, [state.filters]);
  const filterBy = (field: BreakdownField, value: string | null): void => {
    setFilters(
      value === null
        ? state.filters.filter((clause) => clause.field !== field)
        : narrowFilters(
            state.filters,
            field,
            filterValuesFor(field, value, lists.context)
          )
    );
  };

  const refreshKey = JSON.stringify([issuesKey, collection.queryKey]);
  const { open: openCreate, canCreate } = useCreateIssue();
  const mayCreate =
    canCreate &&
    team !== null &&
    canWriteIssues(workspace?.role, team.role) &&
    cycle !== undefined &&
    cycle.status !== 'cancelled' &&
    cycle.status !== 'completed';
  const createIssue = useCallback((): void => {
    if (teamId === '') return;
    openCreate({
      teamId,
      cycleId: id,
      onCreated: () => {
        for (const key of JSON.parse(refreshKey) as string[][]) {
          invalidateQueries(key);
        }
      },
    });
  }, [openCreate, teamId, id, refreshKey]);

  useShortcut({
    keys: 'c',
    label: 'New issue in this cycle',
    group: 'Cycle',
    enabled: mayCreate,
    handler: (event) => {
      event?.preventDefault();
      createIssue();
    },
  });

  const scaleFor = useCallback(
    (memberId: string) =>
      listTeams.find((member) => member.id === memberId)?.estimate_scale ??
      'off',
    [listTeams]
  );
  const countsUnestimated = useCallback(
    (memberId: string) =>
      listTeams.find((member) => member.id === memberId)
        ?.estimate_count_unestimated === true,
    [listTeams]
  );
  const listEstimates = listTeams.some(
    (member) => member.estimate_scale !== 'off'
  );
  const estimateOptionsFor = useCallback(
    (memberId: string) =>
      estimateOptionsOf(listTeams.find((member) => member.id === memberId)),
    [listTeams]
  );
  const teamNameFor = useCallback(
    (memberId: string) =>
      listTeams.find((member) => member.id === memberId)?.name,
    [listTeams]
  );

  const today = dayValue(todayNumber());
  const days = useMemo(
    () =>
      cycle === undefined ? [] : daysBetween(cycle.start_date, cycle.end_date),
    [cycle]
  );
  const recorded = history !== null && history !== undefined;
  const points = useMemo(() => {
    if (recorded) return historySeries(history.days, measure);
    if (cycle === undefined || issues.hasMore || measure === 'points') {
      return [];
    }
    return burnUpSeries(
      issues.rows,
      statuses,
      cycle.start_date,
      cycle.end_date,
      today
    );
  }, [
    recorded,
    history,
    measure,
    cycle,
    issues.hasMore,
    issues.rows,
    statuses,
    today,
  ]);
  const projection = recorded ? projectCompletion(points, days.length) : null;
  const isLoadingChart = !recorded && (isLoadingHistory || issues.isLoading);

  const cyclesHref = teamCyclesPath(slug, keyPrefix ?? '');
  const crumbs = (
    <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
      <Link
        to={cyclesHref}
        className="rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        {team === null ? 'Cycles' : `${team.name} cycles`}
      </Link>
      <LuChevronRight
        className="h-3.5 w-3.5 text-text-faint"
        aria-hidden="true"
      />
    </span>
  );

  if (isResolving || (team !== null && isLoading && cycle === undefined)) {
    return (
      <WorkspaceShell title="Cycle" leading={crumbs}>
        {teamsError !== null && (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load this team.')}
          />
        )}
        <SkeletonRows label="Loading cycle" />
      </WorkspaceShell>
    );
  }

  if (notFound || team === null || cycle === undefined) {
    return (
      <WorkspaceShell title="Cycle not found" leading={crumbs}>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this cycle.')}
          />
        )}
        <EmptyState message="That cycle does not exist, or you are not a member of its team." />
      </WorkspaceShell>
    );
  }

  const canEdit = canWriteIssues(workspace?.role, team.role);
  const canEditCycle =
    canEdit && cycle.status !== 'completed' && cycle.status !== 'cancelled';
  const editCycle = (patch: CyclePatch): void => {
    void update(patch);
  };

  return (
    <WorkspaceShell
      title={<span className="truncate">{cycleTitle(cycle)}</span>}
      titleAccessory={
        <FavoriteButton
          workspaceId={workspaceId}
          kind="cycle"
          targetId={cycle.cycle_id}
          teamId={team.id}
          title={cycleTitle(cycle)}
          preview={{ team_key_prefix: team.key_prefix }}
        />
      }
      leading={crumbs}
      flush
      toolbar={
        <div className="flex items-center gap-2">
          <TeamTabs
            slug={slug}
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
        mayCreate ? (
          <Button variant="primary" onClick={createIssue}>
            <LuPlus aria-hidden="true" />
            New issue
          </Button>
        ) : undefined
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_minmax(0,1fr)] lg:overflow-hidden">
        <CycleHeader
          cycle={cycle}
          measure={measure}
          canEdit={canEditCycle}
          onUpdate={editCycle}
          capacity={capacity}
        />
        <div className="border-b border-line px-4 py-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:overflow-y-auto lg:border-b-0 lg:border-l lg:px-5">
          <CycleProgressPanel
            cycle={cycle}
            measure={measure}
            hasPoints={hasPoints}
            onMeasureChange={setChosenMeasure}
            points={points}
            days={days}
            projection={projection}
            isLoadingChart={isLoadingChart}
            issues={issues.rows}
            statuses={statuses}
            context={lists.context}
            complete={!issues.hasMore}
            isLoadingIssues={issues.isLoading}
            activeFilters={activeFilters}
            onFilter={filterBy}
          />
        </div>
        <section
          aria-label="Cycle issues"
          className="flex min-h-[24rem] flex-col lg:col-start-1 lg:row-start-2 lg:min-h-0"
        >
          <div className="flex flex-col gap-2 border-b border-line px-4 py-2 lg:px-6">
            <div className="flex flex-wrap items-center gap-2">
              <FilterButton
                filters={state.filters}
                match={state.match}
                groups={state.groups}
                context={lists.context}
                onChange={setFilters}
                onLogicChange={setLogic}
              />
              <span className="flex-1" />
              <DisplayMenu
                state={state}
                onChange={setState}
                groupFields={groupFieldsFor(lists.context)}
                context={lists.context}
                estimates={listEstimates}
                onReset={
                  folds.collapsed.size === 0 &&
                  sameViewState(
                    {
                      ...state,
                      filters: base.filters,
                      match: base.match,
                      groups: base.groups,
                      q: base.q,
                    },
                    base
                  )
                    ? undefined
                    : () => {
                        folds.clear();
                        setState({
                          ...base,
                          filters: state.filters,
                          match: state.match,
                          groups: state.groups,
                          q: state.q,
                        });
                      }
                }
              />
            </div>
            <FilterChips
              filters={state.filters}
              match={state.match}
              groups={state.groups}
              context={lists.context}
              onChange={setFilters}
              onLogicChange={setLogic}
            />
          </div>
          <IssueListView
            slug={slug}
            state={state}
            onStateChange={setState}
            collection={collection}
            lists={lists}
            scaleFor={scaleFor}
            countsUnestimated={countsUnestimated}
            estimateOptionsFor={estimateOptionsFor}
            {...(listTeams.length > 1 ? { teamNameFor } : {})}
            canEdit={canEdit}
            createTeamId={mayCreate ? teamId : undefined}
            createCycleId={mayCreate ? id : undefined}
            folds={{ collapsed: folds.collapsed, onToggle: folds.toggle }}
            emptyMessage={
              state.filters.length === 0
                ? 'No issues in this cycle yet.'
                : 'No issues in this cycle match these filters.'
            }
          />
        </section>
      </div>
    </WorkspaceShell>
  );
};

export default CycleDetail;
