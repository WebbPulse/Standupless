/**
 * Projects as bars from their start to their target date on a scrolling
 * timeline, shared by the roadmap and the projects page's timeline layout.
 * Dragging a bar moves both dates, dragging an edge moves one, and clicking
 * the empty lane of an undated project schedules it; each change shows at
 * once and is undone with a notice if the write fails. The names stay pinned
 * on the left, the header stays pinned on top, and a bar's label follows the
 * view so a long bar is always named. Lanes sit under pinned group headers
 * when the rows are grouped. A line runs from the end of each blocking
 * project's bar to the start of the bar it holds up, drawn in the danger tone
 * when the waiting project is planned to start before its blocker ends.
 * Dragging from the dot at a bar's end onto another project makes the first
 * block the second, and dragging from the dot at its start makes it wait on
 * the second. Hovering a line lights it and clicking it offers to remove it,
 * and a focused bar opens the same links from its menu key or Shift+F10.
 * A page can hide the lines and the dots that draw them, leaving the links
 * themselves in the bar menu.
 * Each dated milestone draws as a diamond on its project's lane. A page can
 * choose which of priority, status, health, teams and lead sit beside each
 * name and whether each bar names its progress, and the controls step the
 * view a screen earlier or later as well as back to today and through the
 * zoom levels.
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LuArrowLeft,
  LuArrowRight,
  LuChevronLeft,
  LuChevronRight,
  LuMinus,
  LuPlus,
} from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import { updateProject } from '../../api/planning';
import { useTimelineLinks } from '../../hooks/useTimelineLinks';
import ProjectGroupGlyph from './ProjectGroupGlyph';
import { TeamKey } from './ProjectPickers';
import ProjectHealthGlyph from './ProjectHealthGlyph';
import MilestoneGlyph from './MilestoneGlyph';
import ProjectIcon from './ProjectIcon';
import ProjectStatusGlyph from './ProjectStatusGlyph';
import Avatar from '../ui/avatar';
import Button, { IconButton } from '../ui/button';
import { PriorityGlyph } from '../ui/glyphs';
import { ContextMenu, MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';
import type { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { useOptimisticRecord } from '../../lib/optimistic';
import { projectMilestonePath, projectPath } from '../../lib/paths';
import { healthLabel } from '../../lib/projectLook';
import { useProjectStatuses } from '../../hooks/useProjectStatuses';
import { milestoneProgress, progressPercent } from '../../lib/planningDisplay';
import { isCoarse } from '../../lib/dateResolution';
import { canEditProject } from '../../lib/planningModel';
import {
  dependencyLines,
  dependencyPath,
  draftPath,
  linkFromDrag,
  withPendingLinks,
  type DependencyLine,
  type LinkSide,
} from '../../lib/projectDependencies';
import type { ProjectColumn, ProjectGroup } from '../../lib/projectList';
import {
  PX_PER_DAY,
  TIMELINE_ZOOMS,
  TIMELINE_ZOOM_LABELS,
  barDays,
  clampLabel,
  dayValue,
  dragBar,
  milestoneMarks,
  offscreenSide,
  stepZoom,
  timelineDate,
  timelineHeader,
  timelineRange,
  todayNumber,
  type BarDays,
  type DragMode,
  type TimelineRange,
  type TimelineZoom,
} from '../../lib/timeline';
import type {
  ProjectRead,
  ProjectUpdate,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';

/** The width of the pinned name column, in pixels. */
const NAME_WIDTH = 280;

/** How long a project scheduled from an empty lane runs, in days. */
const DEFAULT_SPAN = 14;

/** How far from the left edge today sits when the view jumps to it. */
const TODAY_INSET = 160;

/** The share of the view one step earlier or later moves it by. */
const STEP_SHARE = 0.8;

/** The properties a timeline shows when its page does not choose. */
const DEFAULT_TIMELINE_COLUMNS: readonly ProjectColumn[] = [
  'health',
  'teams',
  'lead',
  'progress',
];

/** Roughly how wide a bar label is, so it can be kept in view. */
const labelWidth = (name: string): number =>
  Math.min(290, 50 + name.length * 7);

/** The part of the timeline in view, in lane pixels. */
interface ViewWindow {
  left: number;
  right: number;
}

/** A drag in progress. */
interface DragState {
  mode: DragMode;
  originX: number;
  delta: number;
  moved: boolean;
}

/** A link being dragged from a bar's dot, in lane pixels. */
interface LinkDrag {
  sourceId: string;
  side: LinkSide;
  originX: number;
  originY: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  moved: boolean;
  targetId: string | null;
}

/** The menu open on the timeline: a bar's links, or one line's. */
type TimelineMenu =
  | { kind: 'bar'; projectId: string; x: number; y: number }
  | { kind: 'line'; line: DependencyLine; x: number; y: number };

/** A point on the page as lane pixels of the lanes box it falls in. */
const lanePoint = (
  node: HTMLElement | null,
  clientX: number,
  clientY: number
): { x: number; y: number } => {
  const box = node?.getBoundingClientRect();
  return {
    x: clientX - (box?.left ?? 0) - NAME_WIDTH,
    y: clientY - (box?.top ?? 0),
  };
};

/** Props for TimelineRow: one project and the timeline it sits on. */
interface TimelineRowProps {
  project: ProjectRead;
  slug: string;
  workspaceId: string;
  teams: TeamRead[];
  people: Assignable[];
  workspaceRole: WorkspaceRole | undefined;
  range: TimelineRange;
  pxPerDay: number;
  view: ViewWindow;
  /** The properties shown beside the name and on the bar. */
  columns: readonly ProjectColumn[];
  refreshKey: ReturnType<typeof useWorkspaceProjects>['queryKey'];
  onReveal: (day: number) => void;
  /** This project is where the link being dragged would land. */
  linkTarget: boolean;
  /** Whether the dots that drag out a new link show on the bar. */
  linkable: boolean;
  onLinkStart: (
    projectId: string,
    side: LinkSide,
    event: React.PointerEvent<HTMLElement>
  ) => void;
  onLinkOver: (projectId: string, onBar: boolean) => void;
  onLinkOut: (projectId: string, fromBar: boolean) => void;
  onBarMenu: (
    projectId: string,
    x: number,
    y: number,
    origin: HTMLElement | null
  ) => void;
}

/** The bar's own border and fill when a project has picked a colour. */
const barTint = (color: string | null): React.CSSProperties =>
  color === null
    ? {}
    : {
        borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
      };

/** The progress fill inside a bar when a project has picked a colour. */
const fillTint = (color: string | null): React.CSSProperties =>
  color === null
    ? {}
    : { backgroundColor: `color-mix(in srgb, ${color} 32%, transparent)` };

/** One project's row: its name pinned left and its bar on the lane. */
const TimelineRow: React.FC<TimelineRowProps> = ({
  project: server,
  slug,
  workspaceId,
  teams,
  people,
  workspaceRole,
  range,
  pxPerDay,
  view,
  columns,
  refreshKey,
  onReveal,
  linkTarget,
  linkable,
  onLinkStart,
  onLinkOver,
  onLinkOut,
  onBarMenu,
}) => {
  const navigate = useNavigate();
  const { value, update } = useOptimisticRecord<ProjectRead, ProjectUpdate>(
    server,
    {
      write: (patch) => updateProject(workspaceId, server.project_id, patch),
      isSame: (left, right) => left.project_id === right.project_id,
      invalidate: refreshKey,
      failureMessage: (error) =>
        errorMessage(error, 'Could not move that project. It has been undone.'),
    }
  );
  const project = value ?? server;
  const [drag, setDrag] = useState<DragState | null>(null);
  const { statusOf } = useProjectStatuses();
  const editable = canEditProject(workspaceRole, project, teams);
  const percent = progressPercent(project);
  const lead = people.find((person) => person.user_id === project.lead_id);
  const href = projectPath(slug, project.project_id);
  const projectTeams = teams.filter((team) =>
    project.team_ids.includes(team.id)
  );
  const has = (column: ProjectColumn): boolean => columns.includes(column);

  const saved = barDays(project.start_date, project.target_date);
  const bar: BarDays | null =
    saved === null
      ? null
      : drag === null
        ? saved
        : dragBar(saved, drag.mode, drag.delta);

  const save = (next: BarDays): void => {
    if (saved !== null && next.start === saved.start && next.end === saved.end)
      return;
    void update({
      start_date: dayValue(next.start),
      start_date_resolution: 'day',
      target_date: dayValue(next.end),
      target_date_resolution: 'day',
    });
  };

  const beginDrag =
    (mode: DragMode) =>
    (event: React.PointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return;
      event.stopPropagation();
      if (!editable) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDrag({ mode, originX: event.clientX, delta: 0, moved: false });
    };

  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (drag === null) return;
    const delta = Math.round((event.clientX - drag.originX) / pxPerDay);
    const moved = drag.moved || Math.abs(event.clientX - drag.originX) > 3;
    if (delta !== drag.delta || moved !== drag.moved) {
      setDrag({ ...drag, delta, moved });
    }
  };

  const endDrag = (): void => {
    if (drag === null) return;
    const wasClick = !drag.moved && drag.mode === 'move';
    if (saved !== null && drag.delta !== 0) {
      save(dragBar(saved, drag.mode, drag.delta));
    }
    setDrag(null);
    if (wasClick) void navigate(href);
  };

  const onBarKey = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (
      event.key === 'ContextMenu' ||
      (event.shiftKey && event.key === 'F10')
    ) {
      if (!editable) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      onBarMenu(
        project.project_id,
        box.left,
        box.bottom + 4,
        event.currentTarget
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void navigate(href);
      return;
    }
    if (!editable || saved === null) return;
    const step =
      event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const days = event.altKey ? step * 7 : step;
    save(dragBar(saved, event.shiftKey ? 'end' : 'move', days));
  };

  const left = bar === null ? 0 : (bar.start - range.start) * pxPerDay;
  const width = bar === null ? 0 : (bar.end - bar.start + 1) * pxPerDay;
  const wanted = labelWidth(project.name);
  const inside = width >= wanted + 8;
  const side =
    bar === null ? null : offscreenSide(left, width, view.left, view.right);
  const labelLeft = inside
    ? clampLabel(left, width, view.left, wanted) - left + 8
    : width + 6;
  const approximate = drag === null && isCoarse(project.target_date_resolution);
  const dates =
    bar === null
      ? 'Not scheduled'
      : drag === null
        ? `${timelineDate(dayValue(bar.start), project.start_date_resolution)} to ${timelineDate(dayValue(bar.end), project.target_date_resolution)}`
        : `${dayValue(bar.start)} to ${dayValue(bar.end)}`;
  const marks = milestoneMarks(
    project.milestone_markers ?? [],
    range,
    pxPerDay
  );

  return (
    <li
      className="group/row flex h-10 border-b border-line"
      data-timeline-project={project.project_id}
      onPointerEnter={() => {
        onLinkOver(project.project_id, false);
      }}
      onPointerLeave={() => {
        onLinkOut(project.project_id, false);
      }}
    >
      <div
        className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-line bg-bg px-4 text-sm group-hover/row:bg-surface"
        style={{ width: NAME_WIDTH }}
      >
        <ProjectIcon icon={project.icon} color={project.color} />
        <Link
          to={href}
          className="min-w-0 flex-1 truncate font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {project.name}
        </Link>
        {has('priority') && project.priority !== 'none' && (
          <span
            data-timeline-property="priority"
            title={PRIORITY_LABELS[project.priority]}
            className="flex shrink-0 text-text-muted"
          >
            <PriorityGlyph
              priority={project.priority}
              name={PRIORITY_LABELS[project.priority]}
            />
          </span>
        )}
        {has('status') && (
          <span
            data-timeline-property="status"
            title={statusOf(project).name}
            className="flex shrink-0"
          >
            <ProjectStatusGlyph
              status={project.status}
              color={statusOf(project).color}
              percent={percent}
              name={statusOf(project).name}
            />
          </span>
        )}
        {has('health') && project.health !== null && (
          <ProjectHealthGlyph
            health={project.health}
            name={healthLabel(project.health)}
          />
        )}
        {has('teams') &&
          projectTeams
            .slice(0, 2)
            .map((team) => (
              <TeamKey key={team.id} keyPrefix={team.key_prefix} />
            ))}
        {has('lead') && lead !== undefined && (
          <span title={personLabel(lead)}>
            <Avatar
              name={personLabel(lead)}
              src={personAvatar(lead)}
              size="xs"
            />
          </span>
        )}
      </div>
      <div
        className={cn(
          'relative shrink-0',
          bar === null && editable && 'cursor-copy',
          bar !== null && 'pointer-events-none'
        )}
        style={{ width: (range.end - range.start) * pxPerDay }}
        onClick={(event) => {
          if (bar !== null || !editable) return;
          const box = event.currentTarget.getBoundingClientRect();
          const day =
            range.start + Math.floor((event.clientX - box.left) / pxPerDay);
          save({ start: day, end: day + DEFAULT_SPAN - 1 });
        }}
      >
        {bar === null ? (
          editable ? (
            <span
              className="pointer-events-none sticky top-0 hidden h-full items-center pl-3 text-xs text-text-faint group-hover/row:flex"
              style={{ left: NAME_WIDTH }}
            >
              Click to schedule
            </span>
          ) : null
        ) : (
          <>
            <div
              role="slider"
              tabIndex={0}
              aria-label={`${project.name}, ${dates}`}
              aria-valuemin={range.start}
              aria-valuemax={range.end}
              aria-valuenow={bar.start}
              aria-valuetext={dates}
              aria-readonly={!editable}
              title={`${project.name}\n${statusOf(project).name} · ${healthLabel(project.health)} · ${dates}`}
              onPointerDown={beginDrag('move')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={() => {
                setDrag(null);
              }}
              onKeyDown={onBarKey}
              onContextMenu={(event) => {
                if (!editable) return;
                event.preventDefault();
                event.stopPropagation();
                onBarMenu(
                  project.project_id,
                  event.clientX,
                  event.clientY,
                  null
                );
              }}
              onPointerEnter={() => {
                onLinkOver(project.project_id, true);
              }}
              onPointerLeave={() => {
                onLinkOut(project.project_id, true);
              }}
              data-timeline-bar={project.project_id}
              className={cn(
                'pointer-events-auto absolute top-2 flex h-6 items-center overflow-visible rounded-sm border border-accent/40 bg-accent-soft text-xs text-text select-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                editable ? 'cursor-grab' : 'cursor-pointer',
                drag !== null && 'cursor-grabbing shadow-md ring-1 ring-accent',
                linkTarget && 'ring-2 ring-accent'
              )}
              style={{ left, width, ...barTint(project.color) }}
              data-color={project.color ?? ''}
              data-approximate-end={approximate ? 'true' : undefined}
            >
              {approximate && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-0 w-2 rounded-r-sm border-r-2 border-dashed border-accent/60 bg-bg/50"
                />
              )}
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 rounded-l-sm bg-accent/25"
                style={{
                  width: `${String(percent)}%`,
                  ...fillTint(project.color),
                }}
              />
              {editable && (
                <>
                  <span
                    aria-hidden="true"
                    onPointerDown={beginDrag('start')}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    className="absolute inset-y-0 -left-1 z-10 w-2.5 cursor-ew-resize rounded-sm opacity-0 group-hover/row:opacity-100 hover:bg-accent/60"
                  />
                  <span
                    aria-hidden="true"
                    onPointerDown={beginDrag('end')}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    className="absolute inset-y-0 -right-1 z-10 w-2.5 cursor-ew-resize rounded-sm opacity-0 group-hover/row:opacity-100 hover:bg-accent/60"
                  />
                </>
              )}
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute truncate font-medium whitespace-nowrap',
                  inside ? 'text-text' : 'text-text-muted'
                )}
                style={{ left: labelLeft, maxWidth: inside ? width - 16 : 290 }}
              >
                {project.name}
                {has('progress') && (
                  <span
                    data-timeline-property="progress"
                    className="ml-1.5 font-normal text-text-faint tabular-nums"
                  >
                    {`${String(percent)}%`}
                  </span>
                )}
              </span>
            </div>
            {editable &&
              linkable &&
              (['start', 'end'] as const).map((end) => (
                <span
                  key={end}
                  aria-hidden="true"
                  data-link-handle={end}
                  title={
                    end === 'end'
                      ? 'Drag onto a project this one blocks'
                      : 'Drag onto a project this one waits on'
                  }
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onLinkStart(project.project_id, end, event);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  className="pointer-events-auto absolute top-5 z-20 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-crosshair touch-none rounded-full border border-accent bg-bg opacity-0 transition duration-100 group-hover/row:opacity-100 hover:scale-125 hover:bg-accent"
                  style={{
                    left: end === 'start' ? left - 8 : left + width + 8,
                  }}
                />
              ))}
            {drag !== null && drag.moved && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -top-0.5 z-30 rounded-xs bg-raised px-1.5 py-0.5 text-2xs text-text shadow tabular-nums"
                style={{ left }}
              >
                {dates}
              </span>
            )}
            {side !== null && (
              <button
                type="button"
                aria-label={`Scroll to ${project.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onReveal(bar.start);
                }}
                className="pointer-events-auto absolute top-2.5 z-10 inline-flex h-5 items-center gap-1 rounded-xs border border-line bg-surface px-1.5 text-2xs text-text-muted hover:text-text"
                style={
                  side === 'before'
                    ? { left: view.left + 4 }
                    : { left: Math.max(view.left, view.right - 28) }
                }
              >
                {side === 'before' ? (
                  <LuArrowLeft className="h-3 w-3" />
                ) : (
                  <LuArrowRight className="h-3 w-3" />
                )}
              </button>
            )}
          </>
        )}
        {marks.map((mark) => {
          const { state, label } = milestoneProgress(mark);
          return (
            <Link
              key={mark.milestoneId}
              to={projectMilestonePath(
                slug,
                project.project_id,
                mark.milestoneId
              )}
              aria-label={label}
              title={`${label} · ${mark.date}`}
              data-milestone={mark.milestoneId}
              data-completed={state === 'complete' ? 'true' : 'false'}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
              }}
              className="pointer-events-auto absolute top-5 z-20 inline-flex -translate-x-1/2 -translate-y-1/2 rounded-xs bg-bg transition-transform duration-100 hover:scale-125 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              style={{ left: mark.x }}
            >
              <MilestoneGlyph
                milestone={mark}
                size={12}
                decorative
                title={`${label} · ${mark.date}`}
              />
            </Link>
          );
        })}
      </div>
    </li>
  );
};

/** Props for TimelineGroup: one group of lanes and whether it is folded. */
interface TimelineGroupProps {
  group: ProjectGroup;
  teams: TeamRead[];
  folded: boolean;
  onToggle: () => void;
  listLabel: string;
  children: React.ReactNode;
}

/**
 * One group of timeline lanes under a header pinned below the timeline
 * header, or the bare list when the timeline is not grouped.
 */
const TimelineGroup: React.FC<TimelineGroupProps> = ({
  group,
  teams,
  folded,
  onToggle,
  listLabel,
  children,
}) => {
  if (group.kind === 'none') {
    return <ul aria-label={listLabel}>{children}</ul>;
  }
  return (
    <section aria-label={group.label}>
      <div className="sticky top-12 z-20 flex h-8 border-b border-line bg-surface transition-colors duration-100 hover:bg-raised">
        <button
          type="button"
          aria-expanded={!folded}
          onClick={onToggle}
          data-hover="parent"
          className="sticky left-0 flex shrink-0 items-center gap-2 px-4 text-left text-sm font-medium text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
          style={{ width: NAME_WIDTH }}
        >
          <LuChevronRight
            aria-hidden="true"
            className={cn(
              'h-3.5 w-3.5 text-text-faint transition-transform duration-100',
              !folded && 'rotate-90'
            )}
          />
          <ProjectGroupGlyph group={group} teams={teams} />
          <span className="truncate">{group.label}</span>
          <span className="text-xs font-normal text-text-faint tabular-nums">
            {String(group.rows.length)}
          </span>
        </button>
      </div>
      {!folded && <ul aria-label={group.label}>{children}</ul>}
    </section>
  );
};

/** What a page holding a timeline can ask of it. */
export interface ProjectTimelineHandle {
  /** Scrolls the view so today sits near its left edge. */
  scrollToToday: () => void;
  /** Moves the view most of a screen earlier, or later. */
  step: (direction: -1 | 1) => void;
}

/** Props for ProjectTimeline: the grouped rows and how to draw them. */
export interface ProjectTimelineProps {
  groups: ProjectGroup[];
  /** Every project shown, which the dated range is fitted to. */
  projects: ProjectRead[];
  slug: string;
  workspaceId: string;
  teams: TeamRead[];
  people: Assignable[];
  workspaceRole: WorkspaceRole | undefined;
  zoom: TimelineZoom;
  /** Whether the lines between blocking and blocked projects draw, true by default. */
  showDependencies?: boolean;
  /** The properties shown beside each name and on each bar, a lean set by default. */
  columns?: readonly ProjectColumn[];
  folded: string[];
  onToggleGroup: (key: string) => void;
  refreshKey: ReturnType<typeof useWorkspaceProjects>['queryKey'];
  /** The name of the lane list when the rows are not grouped. */
  listLabel: string;
  testId?: string;
  ref?: React.Ref<ProjectTimelineHandle>;
}

/** The scrolling timeline of project bars under a pinned date header. */
export const ProjectTimeline: React.FC<ProjectTimelineProps> = ({
  groups,
  projects,
  slug,
  workspaceId,
  teams,
  people,
  workspaceRole,
  zoom,
  showDependencies = true,
  columns = DEFAULT_TIMELINE_COLUMNS,
  folded,
  onToggleGroup,
  refreshKey,
  listLabel,
  testId,
  ref,
}) => {
  const pxPerDay = PX_PER_DAY[zoom];
  const [today] = useState(() => todayNumber());
  const range = useMemo(
    () =>
      timelineRange(
        projects.flatMap((project) => [
          project.start_date,
          project.target_date,
          ...(project.milestone_markers ?? []).map(
            (marker) => marker.target_date
          ),
        ]),
        today
      ),
    [projects, today]
  );
  const header = useMemo(() => timelineHeader(range, zoom), [range, zoom]);
  const laneWidth = (range.end - range.start) * pxPerDay;

  const scroller = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewWindow>({ left: 0, right: 0 });
  const centre = useRef<number | null>(null);

  const readView = useCallback((): void => {
    const node = scroller.current;
    if (node === null) return;
    const left = node.scrollLeft;
    const right = left + Math.max(0, node.clientWidth - NAME_WIDTH);
    centre.current = range.start + (left + (right - left) / 2) / pxPerDay;
    setView((held) =>
      held.left === left && held.right === right ? held : { left, right }
    );
  }, [range.start, pxPerDay]);

  const scrollToDay = useCallback(
    (day: number, inset = TODAY_INSET): void => {
      const node = scroller.current;
      if (node === null) return;
      node.scrollLeft = Math.max(0, (day - range.start) * pxPerDay - inset);
      readView();
    },
    [range.start, pxPerDay, readView]
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToToday: () => {
        scrollToDay(today);
      },
      step: (direction) => {
        const node = scroller.current;
        if (node === null) return;
        const width = Math.max(0, node.clientWidth - NAME_WIDTH);
        node.scrollLeft = Math.max(
          0,
          node.scrollLeft + direction * Math.round(width * STEP_SHARE)
        );
        readView();
      },
    }),
    [scrollToDay, today, readView]
  );

  const hasRows = projects.length > 0;
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!hasRows) return;
    const node = scroller.current;
    if (node === null) return;
    if (!placed.current) {
      placed.current = true;
      scrollToDay(today);
      return;
    }
    if (centre.current !== null) {
      const half = Math.max(0, node.clientWidth - NAME_WIDTH) / 2;
      scrollToDay(centre.current, half);
    }
  }, [zoom, hasRows, today, scrollToDay]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      readView();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [readView, hasRows]);

  const todayLeft = (today - range.start + 0.5) * pxPerDay;
  const { pending, link, unlink } = useTimelineLinks(
    workspaceId,
    projects,
    refreshKey
  );
  const shown = useMemo(
    () => withPendingLinks(groups, pending),
    [groups, pending]
  );
  const byId = useMemo(
    () =>
      new Map(
        shown.flatMap((group) =>
          group.rows.map((project) => [project.project_id, project] as const)
        )
      ),
    [shown]
  );
  const lines = useMemo(
    () =>
      showDependencies ? dependencyLines(shown, folded, range, pxPerDay) : [],
    [showDependencies, shown, folded, range, pxPerDay]
  );

  const lanes = useRef<HTMLDivElement | null>(null);
  const [linkDrag, setLinkDrag] = useState<LinkDrag | null>(null);
  const linkHeld = useRef<LinkDrag | null>(null);
  const holdLink = useCallback((next: LinkDrag | null): void => {
    linkHeld.current = next;
    setLinkDrag(next);
  }, []);
  const linking = linkDrag !== null;

  const startLink = useCallback(
    (
      projectId: string,
      side: LinkSide,
      event: React.PointerEvent<HTMLElement>
    ): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      if (handle.hasPointerCapture?.(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
      const dot = handle.getBoundingClientRect();
      const from = lanePoint(
        lanes.current,
        dot.left + dot.width / 2,
        dot.top + dot.height / 2
      );
      holdLink({
        sourceId: projectId,
        side,
        originX: event.clientX,
        originY: event.clientY,
        fromX: from.x,
        fromY: from.y,
        toX: from.x,
        toY: from.y,
        moved: false,
        targetId: null,
      });
    },
    [holdLink]
  );

  const overLink = useCallback(
    (projectId: string, onBar: boolean): void => {
      const held = linkHeld.current;
      if (held === null || held.targetId === projectId) return;
      if (projectId === held.sourceId && !onBar) return;
      holdLink({ ...held, targetId: projectId });
    },
    [holdLink]
  );

  const outLink = useCallback(
    (projectId: string, fromBar: boolean): void => {
      const held = linkHeld.current;
      if (held === null || held.targetId !== projectId) return;
      if (fromBar && projectId !== held.sourceId) return;
      holdLink({ ...held, targetId: null });
    },
    [holdLink]
  );

  useEffect(() => {
    if (!linking) return;
    const onMove = (event: PointerEvent): void => {
      const held = linkHeld.current;
      if (held === null) return;
      const point = lanePoint(lanes.current, event.clientX, event.clientY);
      holdLink({
        ...held,
        toX: point.x,
        toY: point.y,
        moved:
          held.moved ||
          Math.hypot(
            event.clientX - held.originX,
            event.clientY - held.originY
          ) > 4,
      });
    };
    const onUp = (): void => {
      const held = linkHeld.current;
      holdLink(null);
      if (held === null || held.targetId === null) return;
      const pair = linkFromDrag(held.side, held.sourceId, held.targetId);
      link(held.sourceId, pair.blockerId, pair.blockedId);
    };
    const onCancel = (): void => {
      holdLink(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      holdLink(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [linking, link, holdLink]);

  const [hoverLine, setHoverLine] = useState<string | null>(null);
  const [menu, setMenu] = useState<TimelineMenu | null>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const openBarMenu = useCallback(
    (projectId: string, x: number, y: number, origin: HTMLElement | null) => {
      menuOrigin.current = origin;
      setMenu({ kind: 'bar', projectId, x, y });
    },
    []
  );
  const closeMenu = useCallback((): void => {
    const origin = menuOrigin.current;
    menuOrigin.current = null;
    setMenu(null);
    origin?.focus();
  }, []);
  const openLineMenu = (
    line: DependencyLine,
    event: React.MouseEvent
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    menuOrigin.current = null;
    setMenu({ kind: 'line', line, x: event.clientX, y: event.clientY });
  };
  const nameOf = (projectId: string): string =>
    byId.get(projectId)?.name ?? 'Another project';
  const editableId = (projectId: string): boolean => {
    const project = byId.get(projectId);
    return (
      project !== undefined && canEditProject(workspaceRole, project, teams)
    );
  };

  const renderMenu = (): React.ReactNode => {
    if (menu === null) return null;
    if (menu.kind === 'line') {
      const { line } = menu;
      const blocker = nameOf(line.blockerId);
      const blocked = nameOf(line.blockedId);
      const pathId = editableId(line.blockerId)
        ? line.blockerId
        : editableId(line.blockedId)
          ? line.blockedId
          : null;
      return (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`${blocker} blocks ${blocked}`}
          onClose={closeMenu}
        >
          <MenuLabel>{`${blocker} blocks ${blocked}`}</MenuLabel>
          <MenuItem to={projectPath(slug, line.blockerId)}>
            {`Open ${blocker}`}
          </MenuItem>
          <MenuItem to={projectPath(slug, line.blockedId)}>
            {`Open ${blocked}`}
          </MenuItem>
          {pathId !== null && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  unlink(pathId, line.blockerId, line.blockedId);
                }}
              >
                Remove dependency
              </MenuItem>
            </>
          )}
        </ContextMenu>
      );
    }
    const project = byId.get(menu.projectId);
    if (project === undefined) return null;
    const projectId = project.project_id;
    const blocking = project.blocking_project_ids ?? [];
    const blockedBy = project.blocked_by_project_ids ?? [];
    const others = projects.filter(
      (other) =>
        other.project_id !== projectId &&
        !blocking.includes(other.project_id) &&
        !blockedBy.includes(other.project_id)
    );
    return (
      <ContextMenu
        x={menu.x}
        y={menu.y}
        label={`Dependencies of ${project.name}`}
        onClose={closeMenu}
      >
        {(blocking.length > 0 || blockedBy.length > 0) && (
          <>
            <MenuLabel>Linked</MenuLabel>
            {blocking.map((otherId) => (
              <MenuItem
                key={`blocks-${otherId}`}
                danger
                onSelect={() => {
                  unlink(projectId, projectId, otherId);
                }}
              >
                {`Remove: blocks ${nameOf(otherId)}`}
              </MenuItem>
            ))}
            {blockedBy.map((otherId) => (
              <MenuItem
                key={`blocked-${otherId}`}
                danger
                onSelect={() => {
                  unlink(projectId, otherId, projectId);
                }}
              >
                {`Remove: blocked by ${nameOf(otherId)}`}
              </MenuItem>
            ))}
            <MenuSeparator />
          </>
        )}
        {others.length === 0 ? (
          <MenuItem disabled>No other projects to link</MenuItem>
        ) : (
          <>
            <MenuLabel>Blocks</MenuLabel>
            {others.map((other) => (
              <MenuItem
                key={`add-blocks-${other.project_id}`}
                onSelect={() => {
                  link(projectId, projectId, other.project_id);
                }}
              >
                {`Blocks ${other.name}`}
              </MenuItem>
            ))}
            <MenuLabel>Blocked by</MenuLabel>
            {others.map((other) => (
              <MenuItem
                key={`add-blocked-${other.project_id}`}
                onSelect={() => {
                  link(projectId, other.project_id, projectId);
                }}
              >
                {`Blocked by ${other.name}`}
              </MenuItem>
            ))}
          </>
        )}
      </ContextMenu>
    );
  };

  return (
    <>
      <div
        ref={scroller}
        onScroll={readView}
        className="relative min-h-0 flex-1 overflow-auto"
        data-testid={testId}
      >
        <div className="relative" style={{ width: NAME_WIDTH + laneWidth }}>
          <div className="sticky top-0 z-30 flex border-b border-line bg-bg">
            <div
              className="sticky left-0 z-10 flex shrink-0 items-end border-r border-line bg-bg px-4 pb-1.5 text-xs text-text-muted"
              style={{ width: NAME_WIDTH }}
            >
              {`${String(projects.length)} ${projects.length === 1 ? 'project' : 'projects'}`}
            </div>
            <div
              className="relative h-12 shrink-0"
              style={{ width: laneWidth }}
              aria-hidden="true"
            >
              {header.major.map((tick) => (
                <span
                  key={`major-${String(tick.day)}`}
                  className="absolute top-0 flex h-6 items-center border-l border-line px-2 text-xs font-medium text-text"
                  style={{
                    left: (tick.day - range.start) * pxPerDay,
                    width: tick.span * pxPerDay,
                  }}
                >
                  <span
                    className="sticky truncate"
                    style={{ left: NAME_WIDTH + 8 }}
                  >
                    {tick.label}
                  </span>
                </span>
              ))}
              {header.minor.map((tick) => (
                <span
                  key={`minor-${String(tick.day)}`}
                  className="absolute top-6 flex h-6 items-center overflow-hidden border-l border-line/60 pl-1 text-2xs text-text-faint"
                  style={{
                    left: (tick.day - range.start) * pxPerDay,
                    width: tick.span * pxPerDay,
                  }}
                >
                  {tick.span * pxPerDay >= 18 ? tick.label : ''}
                </span>
              ))}
              <span
                className="absolute top-6 z-10 -translate-x-1/2 rounded-xs bg-accent px-1 text-2xs font-medium text-bg"
                style={{ left: todayLeft }}
              >
                Today
              </span>
            </div>
          </div>
          <div
            ref={lanes}
            className={cn('relative', linking && 'cursor-crosshair')}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0"
              style={{ left: NAME_WIDTH, width: laneWidth }}
            >
              {header.major.map((tick) => (
                <span
                  key={`grid-${String(tick.day)}`}
                  className="absolute inset-y-0 border-l border-line"
                  style={{ left: (tick.day - range.start) * pxPerDay }}
                />
              ))}
              <span
                className="absolute inset-y-0 z-10 w-px bg-accent"
                style={{ left: todayLeft }}
              />
              {(lines.length > 0 || linkDrag !== null) && (
                <svg
                  className="absolute inset-0 h-full overflow-visible"
                  width={laneWidth}
                  data-testid="timeline-dependencies"
                >
                  {lines.map((line) => {
                    const lit =
                      hoverLine === line.key ||
                      (menu?.kind === 'line' && menu.line.key === line.key);
                    return (
                      <g
                        key={line.key}
                        data-dependency={line.key}
                        data-late={line.late ? 'true' : 'false'}
                        data-active={lit ? 'true' : 'false'}
                        className={
                          lit
                            ? 'text-accent'
                            : line.late
                              ? 'text-danger'
                              : 'text-text-faint'
                        }
                      >
                        <title>{`${nameOf(line.blockerId)} blocks ${nameOf(line.blockedId)}`}</title>
                        <path
                          d={dependencyPath(line)}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={lit ? 2 : 1.25}
                        />
                        <path
                          d={`M ${String(line.toX - 6)} ${String(line.toY - 3.5)} L ${String(line.toX)} ${String(line.toY)} L ${String(line.toX - 6)} ${String(line.toY + 3.5)} Z`}
                          fill="currentColor"
                        />
                        <path
                          d={dependencyPath(line)}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={10}
                          data-dependency-hit={line.key}
                          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                          onPointerEnter={() => {
                            setHoverLine(line.key);
                          }}
                          onPointerLeave={() => {
                            setHoverLine((held) =>
                              held === line.key ? null : held
                            );
                          }}
                          onClick={(event) => {
                            openLineMenu(line, event);
                          }}
                          onContextMenu={(event) => {
                            openLineMenu(line, event);
                          }}
                        />
                      </g>
                    );
                  })}
                  {linkDrag?.moved === true && (
                    <path
                      d={draftPath(
                        linkDrag.side,
                        linkDrag.fromX,
                        linkDrag.fromY,
                        linkDrag.toX,
                        linkDrag.toY
                      )}
                      data-testid="timeline-link-draft"
                      fill="none"
                      className="text-accent"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                  )}
                </svg>
              )}
            </div>
            {groups.map((group) => (
              <TimelineGroup
                key={group.key}
                group={group}
                teams={teams}
                folded={folded.includes(group.key)}
                listLabel={listLabel}
                onToggle={() => {
                  onToggleGroup(group.key);
                }}
              >
                {group.rows.map((project) => (
                  <TimelineRow
                    key={project.project_id}
                    project={project}
                    slug={slug}
                    workspaceId={workspaceId}
                    teams={teams}
                    people={people}
                    workspaceRole={workspaceRole}
                    range={range}
                    pxPerDay={pxPerDay}
                    view={view}
                    columns={columns}
                    refreshKey={refreshKey}
                    onReveal={(day) => {
                      scrollToDay(day, 24);
                    }}
                    linkTarget={linkDrag?.targetId === project.project_id}
                    linkable={showDependencies}
                    onLinkStart={startLink}
                    onLinkOver={overLink}
                    onLinkOut={outLink}
                    onBarMenu={openBarMenu}
                  />
                ))}
              </TimelineGroup>
            ))}
          </div>
        </div>
      </div>
      {renderMenu()}
    </>
  );
};

/** Props for TimelineControls: the zoom and what its buttons do. */
export interface TimelineControlsProps {
  zoom: TimelineZoom;
  onZoomChange: (zoom: TimelineZoom) => void;
  onToday: () => void;
  /** Moves the view earlier or later, left out where the page offers no stepping. */
  onStep?: (direction: -1 | 1) => void;
}

/** The earlier, Today and later buttons and the zoom scale a timeline's toolbar carries. */
export const TimelineControls: React.FC<TimelineControlsProps> = ({
  zoom,
  onZoomChange,
  onToday,
  onStep,
}) => (
  <>
    {onStep !== undefined && (
      <IconButton
        label="Earlier"
        size="sm"
        onClick={() => {
          onStep(-1);
        }}
      >
        <LuChevronLeft className="h-3.5 w-3.5" />
      </IconButton>
    )}
    <Button variant="ghost" size="sm" onClick={onToday}>
      Today
    </Button>
    {onStep !== undefined && (
      <IconButton
        label="Later"
        size="sm"
        onClick={() => {
          onStep(1);
        }}
      >
        <LuChevronRight className="h-3.5 w-3.5" />
      </IconButton>
    )}
    <IconButton
      label="Zoom out"
      size="sm"
      disabled={zoom === 'year'}
      onClick={() => {
        onZoomChange(stepZoom(zoom, 1));
      }}
    >
      <LuMinus className="h-3.5 w-3.5" />
    </IconButton>
    <div
      role="radiogroup"
      aria-label="Zoom"
      className="flex items-center rounded-sm border border-line p-0.5"
    >
      {TIMELINE_ZOOMS.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={zoom === value}
          onClick={() => {
            onZoomChange(value);
          }}
          className={cn(
            'h-6 rounded-xs px-2 text-xs transition-colors duration-100',
            zoom === value
              ? 'bg-raised text-text'
              : 'text-text-muted hover:text-text'
          )}
        >
          {TIMELINE_ZOOM_LABELS[value]}
        </button>
      ))}
    </div>
    <IconButton
      label="Zoom in"
      size="sm"
      disabled={zoom === 'week'}
      onClick={() => {
        onZoomChange(stepZoom(zoom, -1));
      }}
    >
      <LuPlus className="h-3.5 w-3.5" />
    </IconButton>
  </>
);

export default ProjectTimeline;
