/**
 * One cycle. The header carries the dates and the days left, the progress
 * section shows scope against what is started and completed with a burn-up
 * over the cycle's days, and the issues below are grouped by where they are
 * in the workflow.
 *
 * The burn-up reads the cycle's recorded daily history, in issues or in
 * estimate points, with a projection once a few days are in. While that
 * history is unavailable it falls back to a series read off the issues as
 * they are now, so the chart never goes blank on a slow or older backend.
 *
 * On a parent team the cycle rolls up its visible sub-teams' cycles with the
 * same dates: the header, the burn-up and the issues all cover the same set,
 * with the issue list's toggle to show the team alone.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuChevronRight, LuPlus } from 'react-icons/lu';
import { Link, useParams } from 'react-router-dom';
import { getCycle, getCycleHistory } from '../../api/planning';
import BurnUpChart from '../../components/planning/BurnUpChart';
import GroupedIssueList from '../../components/planning/GroupedIssueList';
import MeasureToggle from '../../components/planning/MeasureToggle';
import ProgressRing from '../../components/planning/ProgressRing';
import { ErrorAlert } from '../../components/ui/alert';
import Badge from '../../components/ui/badge';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import SubTeamToggle from '../../components/workspace/SubTeamToggle';
import TeamTabs from '../../components/workspace/TeamTabs';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCreatePlannedIssue } from '../../hooks/useCreatePlannedIssue';
import { usePlanningIssues } from '../../hooks/usePlanningIssues';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useShortcut } from '../../hooks/useShortcuts';
import { useSubTeamRollUp } from '../../hooks/useSubTeamRollUp';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import {
  matchingCycles,
  mergeCycles,
  mergeHistories,
  readRolledUpCycles,
} from '../../lib/cycleRollUp';
import { errorMessage } from '../../lib/errors';
import { teamCyclesPath } from '../../lib/paths';
import {
  CYCLE_STATUS_LABELS,
  completionPercent,
  cycleDatesLabel,
  daysRemainingLabel,
} from '../../lib/planningDisplay';
import {
  burnUpSeries,
  daysBetween,
  historySeries,
  projectCompletion,
  projectionLabel,
  type PlanningMeasure,
} from '../../lib/planningModel';
import { dayValue, todayNumber } from '../../lib/timeline';
import type { CycleHistoryRead, CycleRead } from '../../types/Api';

/** How often the cycle re-reads. */
const POLL_MS = 30000;

/** Props for CycleStats: the cycle whose rollup the cards show, and in what. */
interface CycleStatsProps {
  cycle: CycleRead;
  measure: PlanningMeasure;
}

/** Scope, started and completed as three cards, each with its share. */
const CycleStats: React.FC<CycleStatsProps> = ({ cycle, measure }) => {
  const counts =
    measure === 'points' && cycle.points !== undefined
      ? cycle.points
      : cycle.counts;
  const unit = measure === 'points' ? 'points' : 'issues';
  const scope = counts.total - counts.cancelled;
  const started = counts.in_progress + counts.done;
  const share = (value: number): string =>
    scope <= 0 ? '0%' : `${String(Math.round((value / scope) * 100))}%`;
  const stats = [
    { label: 'Scope', value: scope, detail: `${String(scope)} ${unit}` },
    { label: 'Started', value: started, detail: share(started) },
    { label: 'Completed', value: counts.done, detail: share(counts.done) },
  ];
  return (
    <dl className="grid grid-cols-3 gap-2">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-md border border-line bg-surface px-3 py-2"
        >
          <dt className="text-xs text-text-muted">{stat.label}</dt>
          <dd className="mt-0.5 flex items-baseline gap-2">
            <span className="text-lg font-semibold tabular-nums">
              {stat.value}
            </span>
            <span className="text-xs text-text-faint tabular-nums">
              {stat.detail}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
};

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

/** One cycle's progress, burn-up and issues. */
export const CycleDetail: React.FC = () => {
  const { keyPrefix, cycleId } = useParams<{
    keyPrefix: string;
    cycleId: string;
  }>();
  const { workspace } = useWorkspace();
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
  const own: CycleRead | undefined = data ?? undefined;

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
  const { data: history } = usePolledQuery(readHistory, {
    intervalMs: POLL_MS,
    enabled:
      workspaceId !== '' &&
      teamId !== '' &&
      id !== '' &&
      cycle !== undefined &&
      cycle.status !== 'upcoming',
    queryKey: ['cycleHistory', workspaceId, teamId, id, matchKey],
    auth,
  });

  const hasPoints =
    (team !== null && team.estimate_scale !== 'off') ||
    (cycle?.points?.total ?? 0) > 0;
  const [chosenMeasure, setChosenMeasure] = useState<PlanningMeasure>('issues');
  const measure: PlanningMeasure = hasPoints ? chosenMeasure : 'issues';

  const listTeamIds = useMemo(
    () => (teamId === '' ? [] : rollUp ? [teamId, ...subTeamIds] : [teamId]),
    [teamId, rollUp, subTeamIds]
  );
  const { statuses, labels, people } = usePlanningTeamLists(
    workspaceId,
    listTeamIds
  );
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
  const issues = usePlanningIssues(
    workspaceId,
    issueQuery,
    issuesKey,
    teamId !== '' && id !== ''
  );

  const { open: openCreate, canCreate } = useCreatePlannedIssue(
    workspaceId,
    issuesKey
  );
  const mayCreate =
    canCreate &&
    team !== null &&
    canWriteIssues(workspace?.role, team.role) &&
    cycle !== undefined &&
    cycle.status !== 'cancelled' &&
    cycle.status !== 'completed';
  const createIssue = useCallback((): void => {
    if (teamId === '') return;
    openCreate({ teamId, cycleId: id });
  }, [openCreate, teamId, id]);

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
  const lastPoint = points[points.length - 1];

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

  const percent = completionPercent(cycle.counts);
  const isCurrent = cycle.status === 'active';

  return (
    <WorkspaceShell
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ProgressRing percent={percent} />
          <span className="truncate">{cycle.name}</span>
        </span>
      }
      leading={crumbs}
      toolbar={
        <div className="flex items-center gap-2">
          <TeamTabs slug={slug} keyPrefix={team.key_prefix} current="cycles" />
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
      <div className="space-y-8">
        <section aria-labelledby="cycle-progress" className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="cycle-progress" className="text-sm font-medium">
              Progress
            </h2>
            <Badge tone={isCurrent ? 'accent' : 'neutral'}>
              {isCurrent ? 'Current' : CYCLE_STATUS_LABELS[cycle.status]}
            </Badge>
            <span className="text-xs text-text-muted tabular-nums">
              {cycleDatesLabel(cycle.start_date, cycle.end_date)}
            </span>
            {isCurrent && (
              <span className="text-xs text-text-muted">
                {daysRemainingLabel(cycle.end_date)}
              </span>
            )}
            <span className="ml-auto text-xs text-text-muted tabular-nums">
              {`${String(percent)}% complete`}
            </span>
          </div>
          {cycle.goal !== null && (
            <p className="text-sm text-text-muted">{cycle.goal}</p>
          )}
          <CycleStats cycle={cycle} measure={measure} />
          <CarryOverLine cycle={cycle} measure={measure} />
          <div className="space-y-3 rounded-md border border-line bg-surface p-4">
            {(hasPoints || (projection !== null && lastPoint !== undefined)) &&
              cycle.status !== 'upcoming' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {projection !== null && lastPoint !== undefined && (
                    <span
                      className="text-xs text-text-muted"
                      data-testid="projection-label"
                    >
                      {projectionLabel(projection, lastPoint.scope, measure)}
                    </span>
                  )}
                  {hasPoints && (
                    <span className="ml-auto">
                      <MeasureToggle
                        value={measure}
                        onChange={setChosenMeasure}
                        label="Burn-up measure"
                      />
                    </span>
                  )}
                </div>
              )}
            {cycle.status === 'upcoming' ? (
              <p className="text-sm text-text-muted">
                The burn-up starts drawing once the cycle begins.
              </p>
            ) : (
              <BurnUpChart
                points={points}
                days={days}
                projection={projection}
                unit={measure === 'points' ? 'points' : 'issues'}
                emptyMessage="No issues in this cycle yet, so there is nothing to chart."
              />
            )}
          </div>
        </section>
        <GroupedIssueList
          issues={issues.rows}
          isLoading={issues.isLoading}
          error={issues.error}
          hasMore={issues.hasMore}
          isPaging={issues.isPaging}
          loadMore={issues.loadMore}
          slug={slug}
          statuses={statuses}
          labels={labels}
          people={people}
          emptyMessage="No issues in this cycle yet."
          {...(mayCreate ? { onCreate: createIssue } : {})}
        />
      </div>
    </WorkspaceShell>
  );
};

export default CycleDetail;
