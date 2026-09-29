/**
 * The side panel of a project's overview: how far along it is as scope,
 * started and completed, a graph of those over the project's days, a bar per
 * workflow stage, and each milestone's progress. The API keeps no history of
 * a project's scope, so the graph is read off the issues as they are now and
 * gives way to the numbers alone when they cannot all be read.
 *
 * The latest update heads the panel when there is one, because it is the
 * project's own account of how it is going, with a way through to the rest.
 */

import React, { useMemo } from 'react';
import { LuDiamond } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { completionPercent } from '../../lib/planningDisplay';
import {
  ISSUE_GROUP_LABELS,
  ISSUE_GROUP_ORDER,
  burnUpSeries,
  categoryCounts,
  daysBetween,
  projectGraphRange,
} from '../../lib/planningModel';
import { shortDateLabel } from '../../lib/propertyOptions';
import { PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import { dayValue, todayNumber } from '../../lib/timeline';
import type {
  IssueRead,
  MilestoneRead,
  ProjectRead,
  ProjectUpdateRead,
  StatusCategory,
  StatusRead,
} from '../../types/Api';
import { StatusIcon } from '../ui/StatusIcon';
import Markdown from '../ui/markdown';
import RelativeTime from '../ui/relative-time';
import BurnUpChart from './BurnUpChart';
import ProjectHealthGlyph from './ProjectHealthGlyph';
import ProgressRing from './ProgressRing';

/** Props for ProjectProgressPanel. */
export interface ProjectProgressPanelProps {
  project: ProjectRead;
  issues: IssueRead[];
  statuses: StatusRead[];
  /** Whether every issue of the project has been read, so sums are whole. */
  complete: boolean;
  milestones: MilestoneRead[];
  onOpenMilestone: (milestoneId: string) => void;
  /** The day the graph ends on, for tests; defaults to today. */
  today?: string;
  /** The newest update, shown at the head of the panel when there is one. */
  latestUpdate?: ProjectUpdateRead | null;
  /** How the newest update's author reads. */
  latestAuthor?: string;
  /** Opens the updates tab. */
  onOpenUpdates?: () => void;
}

/** A small uppercase heading for one block of the panel. */
const PanelHeading: React.FC<{ id: string; children: React.ReactNode }> = ({
  id,
  children,
}) => (
  <h2 id={id} className="text-xs font-medium text-text-muted">
    {children}
  </h2>
);

/** The progress, graph, stage bars and milestone progress of one project. */
export const ProjectProgressPanel: React.FC<ProjectProgressPanelProps> = ({
  project,
  issues,
  statuses,
  complete,
  milestones,
  onOpenMilestone,
  today = dayValue(todayNumber()),
  latestUpdate = null,
  latestAuthor = 'Unknown',
  onOpenUpdates,
}) => {
  const { counts } = project;
  const scope = counts.total - counts.cancelled;
  const started = counts.in_progress + counts.done;
  const percent = completionPercent(counts);
  const share = (value: number): string =>
    scope <= 0 ? '0%' : `${String(Math.round((value / scope) * 100))}%`;
  const stats = [
    { label: 'Scope', value: scope, detail: 'issues', tone: 'bg-text-muted' },
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

  const readable = complete && statuses.length > 0;
  const graph = useMemo(() => {
    if (!readable || issues.length === 0) return null;
    const range = projectGraphRange(project, issues, today);
    if (range === null) return null;
    const points = burnUpSeries(
      issues,
      statuses,
      range.start,
      range.end,
      today
    );
    if (points.every((point) => point.scope === 0)) return null;
    return { points, days: daysBetween(range.start, range.end) };
  }, [readable, issues, statuses, project, today]);

  const breakdown: Record<StatusCategory, number> = readable
    ? categoryCounts(issues, statuses)
    : {
        backlog: 0,
        unstarted: counts.todo,
        started: counts.in_progress,
        completed: counts.done,
        cancelled: counts.cancelled,
      };
  const most = Math.max(1, ...Object.values(breakdown));

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
          <span className="ml-auto flex items-center gap-1.5 text-xs text-text-muted tabular-nums">
            <ProgressRing percent={percent} />
            {`${String(percent)}%`}
          </span>
        </div>
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
              : 'The graph draws once the project has issues and has started.'}
          </p>
        ) : (
          <div data-testid="project-progress-graph">
            <BurnUpChart points={graph.points} days={graph.days} />
          </div>
        )}
        <ul aria-label="Issues by status" className="space-y-1.5 pt-1">
          {ISSUE_GROUP_ORDER.map((category) => {
            const count = breakdown[category];
            return (
              <li
                key={category}
                className="grid grid-cols-[6.5rem_minmax(0,1fr)_1.75rem] items-center gap-2 text-xs"
              >
                <span className="flex items-center gap-2 text-text-muted">
                  <StatusIcon status={{ category }} />
                  {ISSUE_GROUP_LABELS[category]}
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-raised">
                  <span
                    className={cn(
                      'block h-full rounded-full',
                      category === 'completed'
                        ? 'bg-accent'
                        : category === 'started'
                          ? 'bg-warning'
                          : 'bg-line-strong'
                    )}
                    style={{ width: `${String((count / most) * 100)}%` }}
                  />
                </span>
                <span className="text-right text-text-muted tabular-nums">
                  {String(count)}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {milestones.length > 0 && (
        <section aria-labelledby="milestone-progress" className="space-y-2">
          <PanelHeading id="milestone-progress">Milestones</PanelHeading>
          <ul aria-label="Milestone progress" className="space-y-0.5">
            {milestones.map((milestone) => {
              const done = completionPercent(milestone.counts);
              return (
                <li key={milestone.milestone_id}>
                  <button
                    type="button"
                    aria-label={`${milestone.name}, ${String(done)}% complete`}
                    onClick={() => {
                      onOpenMilestone(milestone.milestone_id);
                    }}
                    className="flex h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left text-xs transition-colors duration-100 hover:bg-surface focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
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
