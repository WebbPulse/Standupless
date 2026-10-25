/**
 * The side panel of a cycle: scope, started and completed with their shares,
 * the burn-up over the cycle's days, and the cycle's issues broken down by
 * assignee, label, project or priority. A breakdown row filters the issue list to it,
 * and a second click on the active row clears that filter.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import type { BreakdownField } from '../../lib/cycleBreakdown';
import type { IssueContext } from '../../lib/issueView';
import type { BurnUpPoint, PlanningMeasure } from '../../lib/planningModel';
import { projectionLabel } from '../../lib/planningModel';
import type { CycleRead, IssueRead, StatusRead } from '../../types/Api';
import BreakdownTabs from './BreakdownTabs';
import BurnUpChart from './BurnUpChart';
import MeasureToggle from './MeasureToggle';

/** Props for CycleProgressPanel. */
export interface CycleProgressPanelProps {
  cycle: CycleRead;
  measure: PlanningMeasure;
  /** Whether the team estimates, so the points switch is offered. */
  hasPoints: boolean;
  onMeasureChange: (measure: PlanningMeasure) => void;
  points: BurnUpPoint[];
  days: string[];
  projection: number | null;
  /** Whether the burn-up's data is still loading, so it shows a placeholder. */
  isLoadingChart?: boolean;
  /** Every issue of the cycle, unfiltered, for the breakdown. */
  issues: readonly IssueRead[];
  statuses: readonly StatusRead[];
  context: Pick<IssueContext, 'labels' | 'people' | 'projects'>;
  /** Whether every issue of the cycle has been read, so the breakdown is whole. */
  complete: boolean;
  isLoadingIssues: boolean;
  /** The ids the list is filtered to on each breakdown field that has one. */
  activeFilters: Partial<Record<BreakdownField, readonly string[]>>;
  onFilter: (field: BreakdownField, id: string | null) => void;
}

/** The breakdown tabs, in the order they show. */
const FIELDS: readonly BreakdownField[] = [
  'assignee',
  'label',
  'project',
  'priority',
];

/** A small heading for one block of the panel. */
const PanelHeading: React.FC<{ id: string; children: React.ReactNode }> = ({
  id,
  children,
}) => (
  <h2 id={id} className="text-xs font-medium text-text-muted">
    {children}
  </h2>
);

/** Scope, started and completed, each with its share of the scope. */
const CycleStats: React.FC<{
  cycle: CycleRead;
  measure: PlanningMeasure;
}> = ({ cycle, measure }) => {
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
    { label: 'Scope', value: scope, detail: unit, tone: 'bg-text-muted' },
    {
      label: 'Started',
      value: started,
      detail: share(started),
      tone: 'bg-warning',
    },
    {
      label: 'Completed',
      value: counts.done,
      detail: share(counts.done),
      tone: 'bg-accent',
    },
  ];
  return (
    <dl className="grid grid-cols-3 gap-3" data-testid="cycle-stats">
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0">
          <dt className="flex items-center gap-1.5 text-xs text-text-muted">
            <span
              aria-hidden="true"
              className={cn('h-2 w-2 shrink-0 rounded-xs', stat.tone)}
            />
            {stat.label}
          </dt>
          <dd className="mt-0.5 flex items-baseline gap-1">
            <span className="text-base font-semibold text-text tabular-nums">
              {String(stat.value)}
            </span>
            <span className="truncate text-2xs text-text-faint tabular-nums">
              {stat.detail}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
};

/** The progress, burn-up and breakdown of one cycle. */
export const CycleProgressPanel: React.FC<CycleProgressPanelProps> = ({
  cycle,
  measure,
  hasPoints,
  onMeasureChange,
  points,
  days,
  projection,
  isLoadingChart = false,
  issues,
  statuses,
  context,
  complete,
  isLoadingIssues,
  activeFilters,
  onFilter,
}) => {
  const lastPoint = points[points.length - 1];
  return (
    <aside aria-label="Cycle progress" className="space-y-6">
      <section aria-labelledby="cycle-progress" className="space-y-3">
        <div className="flex items-center gap-2">
          <PanelHeading id="cycle-progress">Progress</PanelHeading>
          {hasPoints && (
            <span className="ml-auto">
              <MeasureToggle
                value={measure}
                onChange={onMeasureChange}
                label="Burn-up measure"
              />
            </span>
          )}
        </div>
        <CycleStats cycle={cycle} measure={measure} />
        {cycle.status === 'upcoming' ? (
          <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-text-faint">
            The burn-up starts drawing once the cycle begins.
          </p>
        ) : (
          <div className="space-y-1.5">
            <BurnUpChart
              points={points}
              days={days}
              projection={projection}
              unit={measure === 'points' ? 'points' : 'issues'}
              emptyMessage="No issues in this cycle yet, so there is nothing to chart."
              isLoading={isLoadingChart}
            />
            {!isLoadingChart &&
              projection !== null &&
              lastPoint !== undefined && (
                <p
                  className="text-xs text-text-muted"
                  data-testid="projection-label"
                >
                  {projectionLabel(projection, lastPoint.scope, measure)}
                </p>
              )}
          </div>
        )}
      </section>
      <BreakdownTabs
        subject="cycle"
        fields={FIELDS}
        issues={issues}
        statuses={statuses}
        context={context}
        complete={complete}
        isLoadingIssues={isLoadingIssues}
        activeFilters={activeFilters}
        onFilter={onFilter}
      />
    </aside>
  );
};

export default CycleProgressPanel;
