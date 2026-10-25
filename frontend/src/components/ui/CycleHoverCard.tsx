/**
 * The card a cycle chip opens on hover, after Linear's cycle card: the
 * cycle's title and number, its state with the days left on an active cycle
 * or the days until an upcoming one starts, its dates, its goal, and how far
 * through its scope it is, in points when the team estimates and in issues
 * otherwise. Clicking the title opens the cycle.
 *
 * The cycle is read only once a card opens, under the same query key the
 * cycle page polls, so a cycle already in the cache paints at once and is not
 * read again. A cycle the reader cannot see shows a short note.
 */

import React, { useContext } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Link, useInRouterContext } from 'react-router-dom';
import { getCycle } from '../../api/planning';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { useTeamsFor } from '../../hooks/useTeams';
import { cycleTitle } from '../../lib/cycleBreakdown';
import { cyclePath } from '../../lib/paths';
import {
  CYCLE_STATUS_LABELS,
  daysRemainingLabel,
  daysUntil,
  progressLabel,
  progressPercent,
  type MeasuredProgress,
} from '../../lib/planningDisplay';
import { shortDateLabel } from '../../lib/propertyOptions';
import { cycleKey } from '../../lib/queryKeys';
import type { CycleRead } from '../../types/Api';
import ProgressRing from '../planning/ProgressRing';
import { Badge } from './badge';
import { HoverCard, type HoverCardTriggerProps } from './hover-card';
import { Skeleton } from './skeleton';

/** How often an open card re-reads its cycle. */
const POLL_MS = 60000;

/** The cycle fields the card draws. */
export type CycleCardCycle = Pick<
  CycleRead,
  | 'cycle_id'
  | 'name'
  | 'number'
  | 'start_date'
  | 'end_date'
  | 'goal'
  | 'status'
  | 'counts'
  | 'points'
>;

/** Props for CycleCard: the cycle, how its team measures, and where it links. */
export interface CycleCardProps {
  cycle: CycleCardCycle;
  /** Whether the cycle's team estimates, so progress reads in points. */
  usesPoints?: boolean;
  /** Where the title links to, or null outside a routed workspace. */
  href?: string | null;
  /** The day the days left and days until count from. */
  today?: Date;
}

/** How a cycle's state reads on the card, with days left or days until it starts. */
export const cycleStateLabel = (
  cycle: Pick<CycleRead, 'status' | 'start_date' | 'end_date'>,
  today = new Date()
): string => {
  if (cycle.status === 'active') {
    return `Active · ${daysRemainingLabel(cycle.end_date, today)}`;
  }
  if (cycle.status === 'upcoming') {
    const days = daysUntil(cycle.start_date, today);
    if (days <= 0) return 'Upcoming · Starts today';
    if (days === 1) return 'Upcoming · Starts in 1 day';
    return `Upcoming · Starts in ${String(days)} days`;
  }
  return CYCLE_STATUS_LABELS[cycle.status];
};

/** The cycle's progress in its team's measure: points when it estimates, issues otherwise. */
export const cycleProgress = (
  cycle: Pick<CycleRead, 'counts' | 'points'>,
  usesPoints: boolean
): MeasuredProgress =>
  usesPoints && cycle.points !== undefined
    ? { counts: cycle.counts, measure: 'points', progress: cycle.points }
    : { counts: cycle.counts, measure: 'issues' };

/** One labelled fact on the card, such as the dates. */
const CycleCardRow: React.FC<{
  label: string;
  children: React.ReactNode;
}> = ({ label, children }) => (
  <div className="flex items-center gap-2 text-xs">
    <dt className="w-16 shrink-0 text-text-faint">{label}</dt>
    <dd className="flex min-w-0 items-center gap-1.5 text-text">{children}</dd>
  </div>
);

/** The card's body for one cycle. */
export const CycleCard: React.FC<CycleCardProps> = ({
  cycle,
  usesPoints = false,
  href = null,
  today,
}) => {
  const title = cycleTitle(cycle);
  const numbered =
    cycle.number !== undefined && cycle.number !== null
      ? `Cycle ${String(cycle.number)}`
      : null;
  const progress = cycleProgress(
    cycle,
    usesPoints || (cycle.points?.total ?? 0) > 0
  );
  const percent = progressPercent(progress);
  const goal = cycle.goal?.trim() ?? '';
  return (
    <div className="flex flex-col gap-2.5 p-3" data-testid="cycle-card">
      <div className="flex min-w-0 items-center gap-2">
        {href === null ? (
          <p className="min-w-0 truncate font-medium text-text">{title}</p>
        ) : (
          <Link
            to={href}
            className="min-w-0 truncate rounded-sm font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {title}
          </Link>
        )}
        {numbered !== null && numbered !== title && (
          <span className="shrink-0 text-xs text-text-faint tabular-nums">
            {numbered}
          </span>
        )}
      </div>
      <dl className="flex flex-col gap-1.5">
        <CycleCardRow label="State">
          <Badge tone={cycle.status === 'active' ? 'accent' : 'neutral'}>
            <span data-testid="cycle-card-state">
              {cycleStateLabel(cycle, today)}
            </span>
          </Badge>
        </CycleCardRow>
        <CycleCardRow label="Dates">
          <span className="tabular-nums">
            {`${shortDateLabel(cycle.start_date)} to ${shortDateLabel(cycle.end_date)}`}
          </span>
        </CycleCardRow>
        <CycleCardRow label="Progress">
          <ProgressRing percent={percent} />
          <span data-testid="cycle-card-progress">{percent}%</span>
          <span className="truncate text-text-faint">
            · {progressLabel(progress)}
          </span>
        </CycleCardRow>
      </dl>
      {goal !== '' && (
        <p className="line-clamp-3 text-xs text-text-muted">{goal}</p>
      )}
    </div>
  );
};

/** The card body while the cycle's first read is in flight. */
const CycleCardSkeleton: React.FC = () => (
  <div className="flex flex-col gap-2 p-3" aria-busy="true">
    <Skeleton className="h-4 w-40" />
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-3/4" />
  </div>
);

/** The card's content for one cycle of a team in the open workspace, read on open. */
export const CycleCardBody: React.FC<{ cycleId: string; teamId: string }> = ({
  cycleId,
  teamId,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const workspaceId = workspace?.id ?? '';
  const routed = useInRouterContext();
  const auth = useQueryAuth();
  const { data: cycle, isLoading } = usePolledQuery(
    ({ signal }) => getCycle(workspaceId, cycleId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && teamId !== '' && cycleId !== '',
      queryKey: cycleKey(workspaceId, teamId, cycleId),
      auth,
    }
  );
  const { data: teams } = useTeamsFor(workspaceId);
  if (cycle === null && isLoading) {
    return <CycleCardSkeleton />;
  }
  if (cycle === null || workspace === null) {
    return (
      <p className="p-3 text-xs text-text-muted">
        This cycle was not found, or you do not have access to it.
      </p>
    );
  }
  const team = (teams ?? []).find((item) => item.id === teamId);
  const href =
    routed && team !== undefined
      ? cyclePath(workspace.slug, team.key_prefix, cycle.cycle_id)
      : null;
  return (
    <CycleCard
      cycle={cycle}
      usesPoints={team !== undefined && team.estimate_scale !== 'off'}
      href={href}
    />
  );
};

/** Props for CycleHoverTrigger: the cycle and the element the card hangs off. */
export interface CycleHoverTriggerProps {
  /** The cycle's id, or null when the trigger names none. */
  cycleId: string | null | undefined;
  /** The team the cycle belongs to, which the cycle read is scoped by. */
  teamId: string | null | undefined;
  children: (trigger: Partial<HoverCardTriggerProps>) => React.ReactElement;
}

/** Wraps a trigger so resting on it opens the cycle's card, or draws it plain with no cycle. */
export const CycleHoverTrigger: React.FC<CycleHoverTriggerProps> = ({
  cycleId,
  teamId,
  children,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const id = cycleId ?? '';
  const team = teamId ?? '';
  const known = workspace !== null && id !== '' && team !== '';
  return (
    <HoverCard
      disabled={!known}
      className="w-72"
      content={() => <CycleCardBody cycleId={id} teamId={team} />}
    >
      {children}
    </HoverCard>
  );
};

export default CycleHoverTrigger;
