/**
 * The side panel of a project's overview: how far along it is as scope,
 * started and completed, a graph of those over the project's days, a bar per
 * workflow stage, and each milestone's progress. The graph draws the history
 * the rollup recorded, with today and the target date marked and a dashed
 * projection of the recent completion rate, plus a line saying where that
 * lands against the target. A project with no recorded history yet falls back
 * to a graph read off the issues as they are now, and gives way to the
 * numbers alone when they cannot all be read.
 *
 * Scope, started, completed, the percentage and the graph read in estimate
 * points when a team on the project estimates, each issue weighed on its own
 * team's scale, and in issues otherwise, with the unit named beside the scope.
 * A toggle beside the heading switches them between the two, remembered per
 * viewer and project, with Points disabled when no team on the project
 * estimates. The projection follows the measure shown.
 *
 * The stage list shows each workflow status on its own, from the loaded issues
 * or the project's stored per-status counts, and falls back to one row per
 * category only when neither is to hand.
 *
 * Below the numbers a breakdown by assignee, label and priority reads each
 * row's share done in the same measure, and a row filters the project's
 * issues to it, a second click on the active row clearing that filter.
 * Choosing a milestone scopes the numbers, the graph, the stages and the
 * breakdown to that milestone's issues, with a chip that names it and clears
 * the scope; the project-wide recorded history gives way to a graph read off
 * the milestone's issues while it is scoped.
 *
 * The latest update heads the panel when there is one, because it is the
 * project's own account of how it is going, with a way through to the rest.
 */

import React, { useMemo, useState } from 'react';
import { LuDiamond, LuX } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import type { BreakdownField } from '../../lib/cycleBreakdown';
import type { IssueContext } from '../../lib/issueView';
import {
  completionPercent,
  measureUnit,
  progressMeasureOf,
  progressOf,
  progressPercent,
} from '../../lib/planningDisplay';
import {
  ISSUE_GROUP_LABELS,
  ISSUE_GROUP_ORDER,
  burnUpSeries,
  categoryCounts,
  countEach,
  daysBetween,
  pointWeigher,
  projectGraphRange,
  projectHistoryGraph,
  projectionIn,
  projectionNote,
  type PlanningMeasure,
  type ProjectHistoryGraph,
} from '../../lib/planningModel';
import {
  readProjectMeasure,
  rememberProjectMeasure,
} from '../../lib/projectMeasure';
import { shortDateLabel } from '../../lib/propertyOptions';
import { PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import { statusLook } from '../../lib/statusAppearance';
import { dayValue, todayNumber } from '../../lib/timeline';
import type {
  IssueRead,
  MilestoneRead,
  ProjectHistoryRead,
  ProjectRead,
  ProjectUpdateRead,
  StatusCategory,
  StatusRead,
  TeamRead,
} from '../../types/Api';
import { StatusIcon } from '../ui/StatusIcon';
import Markdown from '../ui/markdown';
import RelativeTime from '../ui/relative-time';
import BurnUpChart from './BurnUpChart';
import MeasureToggle from './MeasureToggle';
import ProjectHealthGlyph from './ProjectHealthGlyph';
import BreakdownTabs from './BreakdownTabs';
import ProgressRing from './ProgressRing';

/** Props for ProjectProgressPanel. */
export interface ProjectProgressPanelProps {
  project: ProjectRead;
  issues: IssueRead[];
  statuses: StatusRead[];
  /** Every team an issue of the project may sit on, for weighing it in points. */
  teams?: readonly TeamRead[];
  /** Whether every issue of the project has been read, so sums are whole. */
  complete: boolean;
  milestones: MilestoneRead[];
  /** Opens a milestone's issues, from the chip of the milestone in scope. */
  onOpenMilestone: (milestoneId: string) => void;
  /** The day the graph ends on, for tests; defaults to today. */
  today?: string;
  /** The newest update, shown at the head of the panel when there is one. */
  latestUpdate?: ProjectUpdateRead | null;
  /** How the newest update's author reads. */
  latestAuthor?: string;
  /** Opens the updates tab. */
  onOpenUpdates?: () => void;
  /** The recorded progress history, drawn in place of the issue-based graph once it has days. */
  history?: ProjectHistoryRead | null;
  /** The labels and people the breakdown names its rows by; no breakdown without it. */
  context?: Pick<IssueContext, 'labels' | 'people' | 'projects'>;
  /** Whether the issues are still loading, so the breakdown shows a placeholder. */
  isLoadingIssues?: boolean;
  /** The ids the project's issues are filtered to on each breakdown field. */
  activeFilters?: Partial<Record<BreakdownField, readonly string[]>>;
  /**
   * Filters the project's issues to a breakdown row, within the scoped
   * milestone when there is one, or clears that field's filter on null.
   */
  onFilter?: (
    field: BreakdownField,
    id: string | null,
    milestoneId: string | null
  ) => void;
}

/** The breakdown tabs a project offers, in the order they show. */
const BREAKDOWN_FIELDS: readonly BreakdownField[] = [
  'assignee',
  'label',
  'priority',
];

/** The default for a panel given no active filters, stable across renders. */
const NO_FILTERS: Partial<Record<BreakdownField, readonly string[]>> = {};

/** A small uppercase heading for one block of the panel. */
const PanelHeading: React.FC<{ id: string; children: React.ReactNode }> = ({
  id,
  children,
}) => (
  <h2 id={id} className="text-xs font-medium text-text-muted">
    {children}
  </h2>
);

/** The four rollup buckets of a per-category tally, so the stats and bars agree. */
const countsOf = (
  breakdown: Record<StatusCategory, number>
): ProjectRead['counts'] => {
  const todo = breakdown.backlog + breakdown.unstarted;
  return {
    todo,
    in_progress: breakdown.started,
    done: breakdown.completed,
    cancelled: breakdown.cancelled,
    total: todo + breakdown.started + breakdown.completed + breakdown.cancelled,
  };
};

/** One row of the stage list: a status, or a whole category as the fallback. */
export interface StageRow {
  key: string;
  label: string;
  category: StatusCategory;
  status: StatusRead | null;
  count: number;
}

/**
 * One row per status holding issues, ordered by category then position. Statuses
 * that share a category and name across a multi-team project read as one row,
 * and a status id no loaded status matches reads as an unknown backlog row.
 */
const statusRows = (
  tally: Record<string, number>,
  statuses: readonly StatusRead[]
): StageRow[] => {
  const byId = new Map(statuses.map((status) => [status.id, status]));
  const rows = new Map<string, StageRow>();
  for (const [statusId, count] of Object.entries(tally)) {
    if (count <= 0) continue;
    const status = byId.get(statusId) ?? null;
    const key =
      status === null ? 'unknown' : `${status.category}:${status.name}`;
    const row = rows.get(key);
    if (row !== undefined) {
      row.count += count;
      continue;
    }
    rows.set(key, {
      key,
      label: status?.name ?? 'Unknown status',
      category: status?.category ?? 'backlog',
      status,
      count,
    });
  }
  const rank = (row: StageRow): number =>
    ISSUE_GROUP_ORDER.indexOf(row.category);
  return [...rows.values()].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      (left.status?.position ?? -1) - (right.status?.position ?? -1) ||
      left.label.localeCompare(right.label)
  );
};

/** The count of issues on each status id. */
const tallyByStatus = (
  issues: readonly IssueRead[]
): Record<string, number> => {
  const tally: Record<string, number> = {};
  for (const issue of issues) {
    tally[issue.status_id] = (tally[issue.status_id] ?? 0) + 1;
  }
  return tally;
};

/** Why Points cannot be chosen on a project whose teams do not estimate. */
export const NO_POINTS_REASON =
  'No team on this project uses estimates, so progress reads in issues.';

/** The default for a panel given no teams, stable so memoised sums keep. */
const NO_TEAMS: readonly TeamRead[] = [];

/** The progress, graph, stage bars and milestone progress of one project. */
export const ProjectProgressPanel: React.FC<ProjectProgressPanelProps> = ({
  project,
  issues: allIssues,
  statuses,
  teams = NO_TEAMS,
  complete,
  milestones,
  onOpenMilestone,
  today = dayValue(todayNumber()),
  latestUpdate = null,
  latestAuthor = 'Unknown',
  onOpenUpdates,
  history: projectHistory = null,
  context,
  isLoadingIssues = false,
  activeFilters = NO_FILTERS,
  onFilter,
}) => {
  const [scopeId, setScopeId] = useState<string | null>(null);
  const scoped =
    milestones.find((milestone) => milestone.milestone_id === scopeId) ?? null;
  const issues = useMemo(
    () =>
      scoped === null
        ? allIssues
        : allIssues.filter(
            (issue) =>
              (issue.project_milestone_id ?? null) === scoped.milestone_id
          ),
    [allIssues, scoped]
  );
  const history = scoped === null ? projectHistory : null;
  const readable = complete && statuses.length > 0;
  const natural = progressMeasureOf(project);
  const pointsReadable = natural === 'points';
  const [choice, setChoice] = useState<{
    projectId: string;
    measure: PlanningMeasure | null;
  }>(() => ({
    projectId: project.project_id,
    measure: readProjectMeasure(project.project_id),
  }));
  const picked =
    choice.projectId === project.project_id
      ? choice.measure
      : readProjectMeasure(project.project_id);
  const measure: PlanningMeasure = pointsReadable
    ? (picked ?? natural)
    : 'issues';
  const choose = (next: PlanningMeasure): void => {
    setChoice({ projectId: project.project_id, measure: next });
    rememberProjectMeasure(project.project_id, next);
  };
  const weigh = useMemo(
    () => (measure === 'points' ? pointWeigher(teams) : countEach),
    [measure, teams]
  );
  const source = scoped ?? project;
  const stored = measure === 'points' ? progressOf(source) : source.counts;
  const breakdown: Record<StatusCategory, number> = useMemo(
    () =>
      readable
        ? categoryCounts(issues, statuses, weigh)
        : {
            backlog: 0,
            unstarted: stored.todo,
            started: stored.in_progress,
            completed: stored.done,
            cancelled: stored.cancelled,
          },
    [readable, issues, statuses, weigh, stored]
  );
  const counts = readable ? countsOf(breakdown) : stored;
  const scope = counts.total - counts.cancelled;
  const started = counts.in_progress + counts.done;
  const percent = completionPercent(counts);
  const share = (value: number): string =>
    scope <= 0 ? '0%' : `${String(Math.round((value / scope) * 100))}%`;
  const stats = [
    {
      label: 'Scope',
      value: scope,
      detail: measureUnit(measure, scope),
      tone: 'bg-text-muted',
    },
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

  const recorded = useMemo(
    () => (history === null ? null : projectHistoryGraph(history, measure)),
    [history, measure]
  );
  const note = useMemo(
    () =>
      recorded === null || history === null
        ? null
        : projectionNote(projectionIn(history, measure), (day) =>
            shortDateLabel(day)
          ),
    [recorded, history, measure]
  );

  const graph = useMemo((): ProjectHistoryGraph | null => {
    if (recorded !== null) return recorded;
    if (!readable || issues.length === 0) return null;
    const range = projectGraphRange(project, issues, today);
    if (range === null) return null;
    const points = burnUpSeries(
      issues,
      statuses,
      range.start,
      range.end,
      today,
      weigh
    );
    if (points.every((point) => point.scope === 0)) return null;
    return {
      points,
      days: daysBetween(range.start, range.end),
      forecast: null,
      targetDate: null,
    };
  }, [recorded, readable, issues, statuses, project, today, weigh]);

  const { stages, perStatus } = useMemo(() => {
    const rows = statusRows(
      readable ? tallyByStatus(issues) : (source.status_counts ?? {}),
      statuses
    );
    if (rows.length > 0) return { stages: rows, perStatus: true };
    return {
      stages: ISSUE_GROUP_ORDER.map((category): StageRow => ({
        key: category,
        label: ISSUE_GROUP_LABELS[category],
        category,
        status: null,
        count: breakdown[category],
      })),
      perStatus: false,
    };
  }, [readable, issues, source.status_counts, statuses, breakdown]);
  const most = Math.max(1, ...stages.map((row) => row.count));
  const stageTotal = stages.reduce((sum, row) => sum + row.count, 0);
  const colorOf = (row: StageRow): string =>
    statusLook(row.status ?? { category: row.category }, statuses).color;

  return (
    <aside
      aria-label="Project progress"
      className="space-y-6 border-line lg:w-80 lg:shrink-0 lg:border-l lg:pl-6"
    >
      {latestUpdate !== null && (
        <section aria-labelledby="project-latest-update" className="space-y-2">
          <div className="flex items-center gap-2">
            <PanelHeading id="project-latest-update">
              Latest update
            </PanelHeading>
            {onOpenUpdates !== undefined && (
              <button
                type="button"
                onClick={onOpenUpdates}
                className="ml-auto rounded-xs text-xs text-text-muted hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
              >
                See all updates
              </button>
            )}
          </div>
          <div className="space-y-1.5 rounded-md border border-line bg-surface px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs">
              <ProjectHealthGlyph health={latestUpdate.health} />
              <span className="font-medium text-text">
                {PROJECT_HEALTH_LABELS[latestUpdate.health]}
              </span>
              <span className="truncate text-text-muted">{latestAuthor}</span>
              <RelativeTime
                value={latestUpdate.created_at}
                className="ml-auto shrink-0"
              />
            </div>
            <Markdown
              source={latestUpdate.body}
              className="line-clamp-4 text-xs text-text-muted"
            />
          </div>
        </section>
      )}

      <section aria-labelledby="project-progress" className="space-y-3">
        <div className="flex items-center gap-2">
          <PanelHeading id="project-progress">Progress</PanelHeading>
          <MeasureToggle
            value={measure}
            onChange={choose}
            label="Progress measure"
            unavailable={
              pointsReadable ? undefined : { points: NO_POINTS_REASON }
            }
          />
          <span className="ml-auto flex items-center gap-1.5 text-xs text-text-muted tabular-nums">
            <ProgressRing percent={percent} />
            {`${String(percent)}%`}
          </span>
        </div>
        {scoped !== null && (
          <div
            data-testid="project-milestone-scope"
            className="flex items-center gap-2 text-xs"
          >
            <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm border border-line bg-surface pr-0.5 pl-2">
              <LuDiamond
                aria-hidden="true"
                className="h-3 w-3 shrink-0 text-text-faint"
              />
              <span className="truncate text-text">{scoped.name}</span>
              <button
                type="button"
                aria-label={`Clear the ${scoped.name} scope`}
                onClick={() => {
                  setScopeId(null);
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted hover:bg-raised hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
              >
                <LuX aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
            <button
              type="button"
              onClick={() => {
                onOpenMilestone(scoped.milestone_id);
              }}
              className="ml-auto shrink-0 rounded-xs text-text-muted hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
            >
              View issues
            </button>
          </div>
        )}
        <dl className="grid grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-xs text-text-muted">
                <span
                  aria-hidden="true"
                  className={cn('h-2 w-2 rounded-xs', stat.tone)}
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
        {graph === null ? (
          <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-text-faint">
            {!complete
              ? 'The graph draws once every issue has loaded.'
              : scoped !== null
                ? 'The graph draws once the milestone has issues and the project has started.'
                : 'The graph draws once the project has issues and has started.'}
          </p>
        ) : (
          <div data-testid="project-progress-graph">
            <BurnUpChart
              points={graph.points}
              days={graph.days}
              unit={measure}
              forecast={graph.forecast}
              targetDate={graph.targetDate}
              showPace={recorded === null}
            />
          </div>
        )}
        {note !== null && (
          <p
            data-testid="project-projection"
            className={cn(
              'text-xs',
              note.late ? 'text-warning' : 'text-text-muted'
            )}
          >
            {note.text}
          </p>
        )}
        {perStatus && stageTotal > 0 && (
          <div
            data-testid="project-status-bar"
            aria-hidden="true"
            className="flex h-1.5 gap-px overflow-hidden rounded-full bg-raised"
          >
            {stages
              .filter((row) => row.count > 0)
              .map((row) => (
                <span
                  key={row.key}
                  data-status={row.label}
                  className="block h-full"
                  style={{
                    width: `${String((row.count / stageTotal) * 100)}%`,
                    backgroundColor: colorOf(row),
                  }}
                />
              ))}
          </div>
        )}
        <ul aria-label="Issues by status" className="space-y-1.5 pt-1">
          {stages.map((row) => (
            <li
              key={row.key}
              className="grid grid-cols-[6.5rem_minmax(0,1fr)_1.75rem] items-center gap-2 text-xs"
            >
              <span className="flex min-w-0 items-center gap-2 text-text-muted">
                <StatusIcon
                  status={row.status ?? { category: row.category }}
                  statuses={statuses}
                />
                <span className="truncate">{row.label}</span>
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-raised">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${String((row.count / most) * 100)}%`,
                    backgroundColor: colorOf(row),
                  }}
                />
              </span>
              <span className="text-right text-text-muted tabular-nums">
                {String(row.count)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {context !== undefined && onFilter !== undefined && (
        <BreakdownTabs
          subject="project"
          fields={BREAKDOWN_FIELDS}
          issues={issues}
          statuses={statuses}
          context={context}
          complete={complete}
          isLoadingIssues={isLoadingIssues}
          activeFilters={activeFilters}
          onFilter={(field, id) => {
            onFilter(field, id, scoped?.milestone_id ?? null);
          }}
          weigh={weigh}
          unit={measure}
        />
      )}

      {milestones.length > 0 && (
        <section aria-labelledby="milestone-progress" className="space-y-2">
          <PanelHeading id="milestone-progress">Milestones</PanelHeading>
          <ul aria-label="Milestone progress" className="space-y-0.5">
            {milestones.map((milestone) => {
              const done = progressPercent(milestone);
              const active = scoped?.milestone_id === milestone.milestone_id;
              return (
                <li key={milestone.milestone_id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    aria-label={`${milestone.name}, ${String(done)}% complete`}
                    onClick={() => {
                      setScopeId(active ? null : milestone.milestone_id);
                    }}
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left text-xs transition-colors duration-100 hover:bg-surface focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                      active && 'bg-raised hover:bg-raised'
                    )}
                  >
                    <LuDiamond
                      aria-hidden="true"
                      className={cn(
                        'h-3 w-3 shrink-0',
                        done >= 100 ? 'text-success' : 'text-text-faint'
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-text">
                      {milestone.name}
                    </span>
                    {milestone.target_date !== null && (
                      <span className="shrink-0 text-2xs text-text-faint tabular-nums">
                        {shortDateLabel(milestone.target_date)}
                      </span>
                    )}
                    <ProgressRing percent={done} size={12} />
                    <span className="w-8 shrink-0 text-right text-text-muted tabular-nums">
                      {`${String(done)}%`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </aside>
  );
};

export default ProjectProgressPanel;
