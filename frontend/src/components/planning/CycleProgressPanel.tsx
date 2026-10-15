/**
 * The side panel of a cycle: scope, started and completed with their shares,
 * the burn-up over the cycle's days, and the cycle's issues broken down by
 * assignee, label or project. A breakdown row filters the issue list to it,
 * and a second click on the active row clears that filter.
 */

import React, { useMemo, useState } from 'react';
import { NONE } from '../../api/issues';
import { cn } from '../../lib/cn';
import {
  breakdownPercent,
  cycleBreakdown,
  type BreakdownField,
  type BreakdownRow,
} from '../../lib/cycleBreakdown';
import { personAvatar } from '../../lib/issuePeople';
import type { IssueContext } from '../../lib/issueView';
import type { BurnUpPoint, PlanningMeasure } from '../../lib/planningModel';
import { projectionLabel } from '../../lib/planningModel';
import type { CycleRead, IssueRead, StatusRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import BurnUpChart from './BurnUpChart';
import MeasureToggle from './MeasureToggle';
import ProgressRing from './ProgressRing';
import ProjectIcon from './ProjectIcon';

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
const TABS: { field: BreakdownField; label: string }[] = [
  { field: 'assignee', label: 'Assignees' },
  { field: 'label', label: 'Labels' },
  { field: 'project', label: 'Projects' },
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

/** The glyph a breakdown row leads with. */
const RowGlyph: React.FC<{
  field: BreakdownField;
  row: BreakdownRow;
  context: CycleProgressPanelProps['context'];
}> = ({ field, row, context }) => {
  if (field === 'assignee') {
    const person =
      row.id === NONE
        ? undefined
        : context.people.find((item) => item.user_id === row.id);
    return (
      <Avatar
        name={row.id === NONE ? '?' : row.name}
        src={personAvatar(person)}
        size="xs"
        className={row.id === NONE ? 'opacity-50' : ''}
      />
    );
  }
  if (field === 'project') {
    const project = context.projects.find((item) => item.project_id === row.id);
    return (
      <ProjectIcon
        icon={project?.icon ?? null}
        color={project?.color ?? null}
        className="h-3.5 w-3.5 shrink-0"
      />
    );
  }
  const label = context.labels.find((item) => item.id === row.id);
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: label?.color ?? 'var(--color-text-faint)' }}
    />
  );
};

/** The breakdown of the cycle by one field, as a tab strip over its rows. */
const Breakdown: React.FC<
  Pick<
    CycleProgressPanelProps,
    | 'issues'
    | 'statuses'
    | 'context'
    | 'complete'
    | 'isLoadingIssues'
    | 'activeFilters'
    | 'onFilter'
  >
> = ({
  issues,
  statuses,
  context,
  complete,
  isLoadingIssues,
  activeFilters,
  onFilter,
}) => {
  const [field, setField] = useState<BreakdownField>('assignee');
  const rows = useMemo(
    () => cycleBreakdown(issues, statuses, field, context),
    [issues, statuses, field, context]
  );
  const panelId = `cycle-breakdown-${field}`;

  return (
    <section aria-labelledby="cycle-breakdown" className="space-y-2">
      <PanelHeading id="cycle-breakdown">Breakdown</PanelHeading>
      <div
        role="tablist"
        aria-label="Break the cycle down by"
        className="flex gap-0.5 rounded-md border border-line p-0.5"
      >
        {TABS.map((tab) => (
          <button
            key={tab.field}
            type="button"
            role="tab"
            id={`cycle-breakdown-tab-${tab.field}`}
            aria-selected={field === tab.field}
            aria-controls={`cycle-breakdown-${tab.field}`}
            onClick={() => {
              setField(tab.field);
            }}
            className={cn(
              'h-6 flex-1 rounded-sm text-xs transition-colors hover:text-text duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
              field === tab.field
                ? 'bg-raised font-medium text-text'
                : 'text-text-muted hover:bg-surface'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={`cycle-breakdown-tab-${field}`}
      >
        {isLoadingIssues && issues.length === 0 ? (
          <ul aria-hidden="true" className="space-y-1.5 py-1">
            {[0, 1, 2].map((index) => (
              <li
                key={index}
                className="h-5 animate-pulse rounded-sm bg-surface"
              />
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-text-faint">
            No issues to break down yet.
          </p>
        ) : (
          <ul
            aria-label={`Issues by ${field}`}
            className="space-y-0.5"
            data-testid="cycle-breakdown-rows"
          >
            {rows.map((row) => {
              const percent = breakdownPercent(row);
              const active = activeFilters[field]?.includes(row.id) === true;
              return (
                <li key={`${field}:${row.id}`}>
                  <button
                    type="button"
                    aria-pressed={active}
                    aria-label={`${row.name}, ${String(row.completed)} of ${String(row.total)} done`}
                    onClick={() => {
                      onFilter(field, active ? null : row.id);
                    }}
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left text-xs transition-colors duration-100 hover:bg-surface focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                      active && 'bg-raised hover:bg-raised'
                    )}
                  >
                    <RowGlyph field={field} row={row} context={context} />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        row.id === NONE ? 'text-text-muted' : 'text-text'
                      )}
                    >
                      {row.name}
                    </span>
                    <ProgressRing percent={percent} size={12} />
                    <span className="w-16 shrink-0 text-right text-text-muted tabular-nums">
                      {`${String(percent)}% of ${String(row.total)}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!complete && rows.length > 0 && (
          <p className="pt-1.5 text-2xs text-text-faint">
            Counts cover the issues loaded so far.
          </p>
        )}
      </div>
    </section>
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
            />
            {projection !== null && lastPoint !== undefined && (
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
      <Breakdown
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
