/**
 * One cycle. The header carries the dates and the days left, the progress
 * section shows scope against what is started and completed with a burn-up
 * over the cycle's days, and the issues below are grouped by where they are
 * in the workflow. The burn-up is drawn from the issues the page already
 * reads, because the API keeps no history of a cycle's scope.
 */

import React, { useCallback, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuChevronRight, LuPlus } from 'react-icons/lu';
import { Link, useParams } from 'react-router-dom';
import { getCycle } from '../../api/planning';
import BurnUpChart from '../../components/planning/BurnUpChart';
import GroupedIssueList from '../../components/planning/GroupedIssueList';
import ProgressRing from '../../components/planning/ProgressRing';
import { ErrorAlert } from '../../components/ui/alert';
import Badge from '../../components/ui/badge';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import TeamTabs from '../../components/workspace/TeamTabs';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCreatePlannedIssue } from '../../hooks/useCreatePlannedIssue';
import { usePlanningIssues } from '../../hooks/usePlanningIssues';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { teamCyclesPath } from '../../lib/paths';
import {
  CYCLE_STATUS_LABELS,
  completionPercent,
  cycleDatesLabel,
  daysRemainingLabel,
} from '../../lib/planningDisplay';
import { burnUpSeries, daysBetween } from '../../lib/planningModel';
import { dayValue, todayNumber } from '../../lib/timeline';
import type { CycleRead } from '../../types/Api';

/** How often the cycle re-reads. */
const POLL_MS = 30000;

/** Props for CycleStats: the cycle whose rollup the cards show. */
interface CycleStatsProps {
  cycle: CycleRead;
}

/** Scope, started and completed as three cards, each with its share. */
const CycleStats: React.FC<CycleStatsProps> = ({ cycle }) => {
  const { counts } = cycle;
  const scope = counts.total - counts.cancelled;
  const started = counts.in_progress + counts.done;
  const share = (value: number): string =>
    scope <= 0 ? '0%' : `${String(Math.round((value / scope) * 100))}%`;
  const stats = [
    { label: 'Scope', value: scope, detail: `${String(scope)} issues` },
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
  const cycle: CycleRead | undefined = data ?? undefined;

  const { statuses, labels, people } = usePlanningTeamLists(
    workspaceId,
    teamId === '' ? [] : [teamId]
  );
  const issuesKey = ['cycleIssues', workspaceId, teamId, id] as const;
  const issues = usePlanningIssues(
    workspaceId,
    { team_id: teamId, cycle_id: id },
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
  const points = useMemo(
    () =>
      cycle === undefined || issues.hasMore
        ? []
        : burnUpSeries(
            issues.rows,
            statuses,
            cycle.start_date,
            cycle.end_date,
            today
          ),
    [cycle, issues.hasMore, issues.rows, statuses, today]
  );

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
        <TeamTabs slug={slug} keyPrefix={team.key_prefix} current="cycles" />
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
          <CycleStats cycle={cycle} />
          <div className="rounded-md border border-line bg-surface p-4">
            {cycle.status === 'upcoming' ? (
              <p className="text-sm text-text-muted">
                The burn-up starts drawing once the cycle begins.
              </p>
            ) : (
              <BurnUpChart points={points} days={days} />
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
