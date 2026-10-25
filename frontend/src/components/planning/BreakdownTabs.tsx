/**
 * A cycle's or project's issues broken down by one field at a time, as a tab
 * strip over rows that each read the share done out of the row's scope. A row
 * filters the issue list to it, and a second click on the active row clears
 * that filter. The cycle and project progress panels share it.
 */

import React, { useMemo, useState } from 'react';
import { NONE } from '../../api/issues';
import { cn } from '../../lib/cn';
import {
  breakdownPercent,
  cycleBreakdown,
  type BreakdownField,
  type BreakdownRow,
  type BreakdownWeigher,
} from '../../lib/cycleBreakdown';
import { personAvatar } from '../../lib/issuePeople';
import type { IssueContext } from '../../lib/issueView';
import type { IssuePriority, IssueRead, StatusRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { PriorityGlyph } from '../ui/glyphs';
import ProgressRing from './ProgressRing';
import ProjectIcon from './ProjectIcon';

/** The label each breakdown field's tab reads. */
export const BREAKDOWN_TAB_LABELS: Record<BreakdownField, string> = {
  assignee: 'Assignees',
  label: 'Labels',
  project: 'Projects',
  priority: 'Priorities',
};

/** Props for BreakdownTabs. */
export interface BreakdownTabsProps {
  /** What is broken down, which names the ids and the tab strip. */
  subject: 'cycle' | 'project';
  /** The tabs offered, in the order they show. */
  fields: readonly BreakdownField[];
  issues: readonly IssueRead[];
  statuses: readonly StatusRead[];
  context: Pick<IssueContext, 'labels' | 'people' | 'projects'>;
  /** Whether every issue has been read, so the breakdown is whole. */
  complete: boolean;
  isLoadingIssues: boolean;
  /** The ids the list is filtered to on each breakdown field that has one. */
  activeFilters: Partial<Record<BreakdownField, readonly string[]>>;
  onFilter: (field: BreakdownField, id: string | null) => void;
  /** Weighs each issue, so the rows read in points; issues when left out. */
  weigh?: BreakdownWeigher;
  /** The unit the rows read in, named in each row's label when it is points. */
  unit?: 'issues' | 'points';
}

/** The glyph a breakdown row leads with. */
const RowGlyph: React.FC<{
  field: BreakdownField;
  row: BreakdownRow;
  context: BreakdownTabsProps['context'];
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
  if (field === 'priority') {
    return <PriorityGlyph priority={row.id as IssuePriority} />;
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

/** The breakdown, as a tab strip over the rows of the chosen field. */
export const BreakdownTabs: React.FC<BreakdownTabsProps> = ({
  subject,
  fields,
  issues,
  statuses,
  context,
  complete,
  isLoadingIssues,
  activeFilters,
  onFilter,
  weigh,
  unit = 'issues',
}) => {
  const [chosen, setChosen] = useState<BreakdownField>(fields[0] ?? 'assignee');
  const field = fields.includes(chosen) ? chosen : (fields[0] ?? 'assignee');
  const rows = useMemo(
    () => cycleBreakdown(issues, statuses, field, context, weigh),
    [issues, statuses, field, context, weigh]
  );
  const prefix = `${subject}-breakdown`;
  const amount = (value: number): string =>
    unit === 'points' ? `${String(value)} points` : String(value);

  return (
    <section aria-labelledby={prefix} className="space-y-2">
      <h2 id={prefix} className="text-xs font-medium text-text-muted">
        Breakdown
      </h2>
      <div
        role="tablist"
        aria-label={`Break the ${subject} down by`}
        className="flex gap-0.5 rounded-md border border-line p-0.5"
      >
        {fields.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${prefix}-tab-${value}`}
            aria-selected={field === value}
            aria-controls={`${prefix}-${value}`}
            onClick={() => {
              setChosen(value);
            }}
            className={cn(
              'h-6 flex-1 rounded-sm text-xs transition-colors hover:text-text duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
              field === value
                ? 'bg-raised font-medium text-text'
                : 'text-text-muted hover:bg-surface'
            )}
          >
            {BREAKDOWN_TAB_LABELS[value]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${prefix}-${field}`}
        aria-labelledby={`${prefix}-tab-${field}`}
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
            data-testid={`${prefix}-rows`}
          >
            {rows.map((row) => {
              const percent = breakdownPercent(row);
              const active = activeFilters[field]?.includes(row.id) === true;
              return (
                <li key={`${field}:${row.id}`}>
                  <button
                    type="button"
                    aria-pressed={active}
                    aria-label={`${row.name}, ${String(row.completed)} of ${amount(row.total)} done`}
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

export default BreakdownTabs;
