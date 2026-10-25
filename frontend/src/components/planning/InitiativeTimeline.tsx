/**
 * Initiatives as bars from their start to their target date on the shared
 * planning timeline, the initiatives page's Timeline layout. Sub-initiatives
 * and the projects an initiative holds nest under it and fold away with its
 * chevron. Dragging a bar moves both its dates, dragging an end moves one,
 * and clicking the empty lane of an undated initiative schedules it; each
 * change shows at once, says so in a notice with Undo, and is put back by
 * Ctrl+Z or Cmd+Z. A branch with no date anywhere sits in a No dates section
 * below the rest. Project bars are drawn for context and open their project.
 */

import React, { useMemo, useState } from 'react';
import {
  LuArrowLeft,
  LuArrowRight,
  LuChevronDown,
  LuChevronRight,
  LuGoal,
} from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import ProjectIcon from './ProjectIcon';
import {
  TimelineDateHeader,
  TimelineGrid,
  useNameWidth,
  useTimelineView,
  type TimelineHandle,
  type ViewWindow,
} from './TimelineFrame';
import type { InitiativeMove } from '../../hooks/useInitiativeMoves';
import { cn } from '../../lib/cn';
import { isCoarse } from '../../lib/dateResolution';
import {
  dragChange,
  heldDates,
  initiativeTimelineRows,
  laneDates,
  type InitiativeTimelineLane,
} from '../../lib/initiativeTimeline';
import { initiativePath, projectPath } from '../../lib/paths';
import { progressPercent } from '../../lib/planningDisplay';
import {
  PX_PER_DAY,
  barDays,
  clampLabel,
  dayValue,
  dragBar,
  offscreenSide,
  timelineDate,
  timelineHeader,
  timelineRange,
  todayNumber,
  type BarDays,
  type DragMode,
  type TimelineRange,
  type TimelineZoom,
} from '../../lib/timeline';
import { pushUndo } from '../../lib/undo';
import type { InitiativeRead, ProjectRead } from '../../types/Api';

/** How long an initiative scheduled from an empty lane runs, in days. */
const DEFAULT_SPAN = 28;

/** How far each level of nesting is indented, in pixels. */
const INDENT_PX = 18;

/** Roughly how wide a bar label is, so it can be kept in view. */
const labelWidth = (name: string): number =>
  Math.min(290, 50 + name.length * 7);

/** A drag in progress. */
interface DragState {
  mode: DragMode;
  originX: number;
  delta: number;
  moved: boolean;
}

/** Props for a lane's name cell: what it names and how deep it sits. */
interface LaneNameProps {
  depth: number;
  children: React.ReactNode;
}

/** The pinned name cell every lane starts with. */
const LaneName: React.FC<LaneNameProps> = ({ depth, children }) => {
  const nameWidth = useNameWidth();
  return (
    <div
      className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-line bg-bg px-4 text-sm group-hover/row:bg-surface"
      style={{ width: nameWidth, paddingLeft: 16 + depth * INDENT_PX }}
    >
      {children}
    </div>
  );
};

/** Props for the button that scrolls a bar back into view. */
interface RevealProps {
  name: string;
  side: 'before' | 'after';
  view: ViewWindow;
  onReveal: () => void;
}

/** The arrow at the edge of the view that scrolls to a bar outside it. */
const Reveal: React.FC<RevealProps> = ({ name, side, view, onReveal }) => (
  <button
    type="button"
    aria-label={`Scroll to ${name}`}
    onClick={(event) => {
      event.stopPropagation();
      onReveal();
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
);

/** Props for InitiativeLaneRow: one initiative and the timeline it sits on. */
interface InitiativeLaneRowProps {
  initiative: InitiativeRead;
  depth: number;
  childCount: number;
  collapsed: boolean;
  onToggle: (initiativeId: string) => void;
  slug: string;
  editable: boolean;
  range: TimelineRange;
  pxPerDay: number;
  view: ViewWindow;
  onChange: (
    initiative: InitiativeRead,
    change: InitiativeMove,
    mode: DragMode | 'schedule'
  ) => void;
  onReveal: (day: number) => void;
}

/** One initiative's lane: its name pinned on the left and its bar, or an empty lane to schedule. */
const InitiativeLaneRow: React.FC<InitiativeLaneRowProps> = ({
  initiative,
  depth,
  childCount,
  collapsed,
  onToggle,
  slug,
  editable,
  range,
  pxPerDay,
  view,
  onChange,
  onReveal,
}) => {
  const navigate = useNavigate();
  const [drag, setDrag] = useState<DragState | null>(null);
  const nameWidth = useNameWidth();
  const href = initiativePath(slug, initiative);
  const percent = progressPercent(initiative);
  const saved = barDays(initiative.start_date ?? null, initiative.target_date);
  const bar: BarDays | null =
    saved === null
      ? null
      : drag === null
        ? saved
        : dragBar(saved, drag.mode, drag.delta);

  const save = (mode: DragMode, next: BarDays): void => {
    if (saved !== null && next.start === saved.start && next.end === saved.end)
      return;
    onChange(initiative, dragChange(initiative, mode, next), mode);
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
      save(drag.mode, dragBar(saved, drag.mode, drag.delta));
    }
    setDrag(null);
    if (wasClick) void navigate(href);
  };

  const onBarKey = (event: React.KeyboardEvent<HTMLElement>): void => {
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
    const mode: DragMode = event.shiftKey ? 'end' : 'move';
    save(mode, dragBar(saved, mode, days));
  };

  const left = bar === null ? 0 : (bar.start - range.start) * pxPerDay;
  const width = bar === null ? 0 : (bar.end - bar.start + 1) * pxPerDay;
  const wanted = labelWidth(initiative.name);
  const inside = width >= wanted + 8;
  const side =
    bar === null ? null : offscreenSide(left, width, view.left, view.right);
  const labelLeft = inside
    ? clampLabel(left, width, view.left, wanted) - left + 8
    : width + 6;
  const approximate =
    drag === null && isCoarse(initiative.target_date_resolution);
  const dates =
    bar === null
      ? 'No dates'
      : drag === null
        ? `${timelineDate(dayValue(bar.start), initiative.start_date_resolution)} to ${timelineDate(dayValue(bar.end), initiative.target_date_resolution)}`
        : `${dayValue(bar.start)} to ${dayValue(bar.end)}`;

  return (
    <li
      className="group/row flex h-10 border-b border-line"
      data-timeline-initiative={initiative.initiative_id}
    >
      <LaneName depth={depth}>
        {childCount > 0 ? (
          <button
            type="button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${initiative.name}`}
            aria-expanded={!collapsed}
            onClick={() => {
              onToggle(initiative.initiative_id);
            }}
            className="-mx-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted hover:bg-raised hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {collapsed ? (
              <LuChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <LuChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span aria-hidden="true" className="-mx-1 w-5 shrink-0" />
        )}
        <LuGoal
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-text-muted"
        />
        <Link
          to={href}
          className="min-w-0 flex-1 truncate font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {initiative.name}
        </Link>
        {collapsed && childCount > 0 && (
          <span className="shrink-0 text-xs text-text-faint tabular-nums">
            {String(childCount)}
          </span>
        )}
      </LaneName>
      <div
        className={cn(
          'relative shrink-0',
          bar === null && editable && 'cursor-copy',
          bar !== null && 'pointer-events-none'
        )}
        style={{ width: (range.end - range.start) * pxPerDay }}
        data-testid={`initiative-lane-${initiative.initiative_id}`}
        onClick={(event) => {
          if (bar !== null || !editable) return;
          const box = event.currentTarget.getBoundingClientRect();
          const day =
            range.start + Math.floor((event.clientX - box.left) / pxPerDay);
          onChange(
            initiative,
            {
              start_date: dayValue(day),
              target_date: dayValue(day + DEFAULT_SPAN - 1),
            },
            'schedule'
          );
        }}
      >
        {bar === null ? (
          editable ? (
            <span
              className="pointer-events-none sticky top-0 hidden h-full items-center pl-3 text-xs text-text-faint group-hover/row:flex"
              style={{ left: nameWidth }}
            >
              Click to schedule
            </span>
          ) : null
        ) : (
          <>
            <div
              role="slider"
              tabIndex={0}
              aria-label={`${initiative.name}, ${dates}`}
              aria-valuemin={range.start}
              aria-valuemax={range.end}
              aria-valuenow={bar.start}
              aria-valuetext={dates}
              aria-readonly={!editable}
              title={`${initiative.name}\n${dates}`}
              onPointerDown={beginDrag('move')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={() => {
                setDrag(null);
              }}
              onKeyDown={onBarKey}
              data-timeline-bar={initiative.initiative_id}
              data-approximate-end={approximate ? 'true' : undefined}
              className={cn(
                'pointer-events-auto absolute top-2 flex h-6 items-center overflow-visible rounded-sm border border-accent/40 bg-accent-soft text-xs text-text select-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                editable ? 'cursor-grab' : 'cursor-pointer',
                drag !== null && 'cursor-grabbing shadow-md ring-1 ring-accent'
              )}
              style={{ left, width }}
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
                style={{ width: `${String(percent)}%` }}
              />
              {editable && (
                <>
                  <span
                    aria-hidden="true"
                    data-bar-edge="start"
                    onPointerDown={beginDrag('start')}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    className="absolute inset-y-0 -left-1 z-10 w-2.5 cursor-ew-resize rounded-sm opacity-0 group-hover/row:opacity-100 hover:bg-accent/60"
                  />
                  <span
                    aria-hidden="true"
                    data-bar-edge="end"
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
                {initiative.name}
                <span className="ml-1.5 font-normal text-text-faint tabular-nums">
                  {`${String(percent)}%`}
                </span>
              </span>
            </div>
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
              <Reveal
                name={initiative.name}
                side={side}
                view={view}
                onReveal={() => {
                  onReveal(bar.start);
                }}
              />
            )}
          </>
        )}
      </div>
    </li>
  );
};

/** Props for ProjectLaneRow: one project held by an initiative above it. */
interface ProjectLaneRowProps {
  project: ProjectRead;
  depth: number;
  slug: string;
  range: TimelineRange;
  pxPerDay: number;
  view: ViewWindow;
  onReveal: (day: number) => void;
}

/** One project's lane under its initiative, its bar a link to the project. */
const ProjectLaneRow: React.FC<ProjectLaneRowProps> = ({
  project,
  depth,
  slug,
  range,
  pxPerDay,
  view,
  onReveal,
}) => {
  const href = projectPath(slug, project);
  const bar = barDays(project.start_date, project.target_date);
  const left = bar === null ? 0 : (bar.start - range.start) * pxPerDay;
  const width = bar === null ? 0 : (bar.end - bar.start + 1) * pxPerDay;
  const side =
    bar === null ? null : offscreenSide(left, width, view.left, view.right);
  const wanted = labelWidth(project.name);
  const inside = width >= wanted + 8;
  const labelLeft = inside
    ? clampLabel(left, width, view.left, wanted) - left + 8
    : width + 6;
  const dates =
    bar === null
      ? 'No dates'
      : `${timelineDate(dayValue(bar.start), project.start_date_resolution)} to ${timelineDate(dayValue(bar.end), project.target_date_resolution)}`;
  return (
    <li
      className="group/row flex h-9 border-b border-line"
      data-timeline-project={project.project_id}
    >
      <LaneName depth={depth}>
        <span aria-hidden="true" className="-mx-1 w-5 shrink-0" />
        <ProjectIcon icon={project.icon} color={project.color} />
        <Link
          to={href}
          className="min-w-0 flex-1 truncate text-text-muted hover:text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {project.name}
        </Link>
      </LaneName>
      <div
        className="pointer-events-none relative shrink-0"
        style={{ width: (range.end - range.start) * pxPerDay }}
      >
        {bar !== null && (
          <>
            <Link
              to={href}
              aria-label={`${project.name}, ${dates}`}
              title={`${project.name}\n${dates}`}
              data-timeline-project-bar={project.project_id}
              className="pointer-events-auto absolute top-2 flex h-5 items-center rounded-sm border border-line bg-surface text-xs text-text-muted hover:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              style={{ left, width }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute truncate whitespace-nowrap',
                  inside ? 'text-text-muted' : 'text-text-faint'
                )}
                style={{ left: labelLeft, maxWidth: inside ? width - 16 : 290 }}
              >
                {project.name}
              </span>
            </Link>
            {side !== null && (
              <Reveal
                name={project.name}
                side={side}
                view={view}
                onReveal={() => {
                  onReveal(bar.start);
                }}
              />
            )}
          </>
        )}
      </div>
    </li>
  );
};

/** The verb a change's notice names, by what moved. */
const CHANGE_VERBS: Record<DragMode | 'schedule', string> = {
  move: 'Moved',
  start: 'Changed the start of',
  end: 'Changed the target of',
  schedule: 'Scheduled',
};

/** Props for InitiativeTimeline: the initiatives shown and how to change them. */
export interface InitiativeTimelineProps {
  /** The initiatives the page shows, filtered and in its order. */
  initiatives: InitiativeRead[];
  /** Every project the person can see, so each initiative's are nested under it. */
  projects: readonly ProjectRead[];
  slug: string;
  workspaceId: string;
  zoom: TimelineZoom;
  editable: boolean;
  /** Writes a change of dates, answering whether it was stored. */
  move: (
    initiative: InitiativeRead,
    change: InitiativeMove
  ) => Promise<boolean>;
  /** Writes dates back for undo, rejecting when the write fails. */
  put: (initiative: InitiativeRead, change: InitiativeMove) => Promise<void>;
  testId?: string;
  ref?: React.Ref<TimelineHandle>;
}

/** The scrolling timeline of initiative bars under a pinned date header. */
export const InitiativeTimeline: React.FC<InitiativeTimelineProps> = ({
  initiatives,
  projects,
  slug,
  workspaceId,
  zoom,
  editable,
  move,
  put,
  testId,
  ref,
}) => {
  const pxPerDay = PX_PER_DAY[zoom];
  const [today] = useState(() => todayNumber());
  const nameWidth = useNameWidth();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const lanes = useMemo(
    () => initiativeTimelineRows(initiatives, projects, collapsed),
    [initiatives, projects, collapsed]
  );
  const range = useMemo(
    () => timelineRange(laneDates([...lanes.dated, ...lanes.undated]), today),
    [lanes, today]
  );
  const header = useMemo(() => timelineHeader(range, zoom), [range, zoom]);
  const laneWidth = (range.end - range.start) * pxPerDay;
  const { scroller, view, readView, scrollToDay } = useTimelineView({
    range,
    pxPerDay,
    zoom,
    today,
    hasRows: initiatives.length > 0,
    ref,
  });
  const todayLeft = (today - range.start + 0.5) * pxPerDay;
  const latest = useMemo(
    () => new Map(initiatives.map((row) => [row.initiative_id, row] as const)),
    [initiatives]
  );

  const toggle = (initiativeId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(initiativeId)) next.delete(initiativeId);
      else next.add(initiativeId);
      return next;
    });
  };

  const change = (
    initiative: InitiativeRead,
    patch: InitiativeMove,
    mode: DragMode | 'schedule'
  ): void => {
    const before = heldDates(initiative);
    void move(initiative, patch).then((stored) => {
      if (!stored) return;
      pushUndo(
        workspaceId,
        `${CHANGE_VERBS[mode]} ${initiative.name}`,
        async () => {
          const current = latest.get(initiative.initiative_id) ?? {
            ...initiative,
            ...patch,
          };
          await put(current, before);
        }
      );
    });
  };

  const renderLane = (lane: InitiativeTimelineLane): React.ReactNode =>
    lane.kind === 'initiative' ? (
      <InitiativeLaneRow
        key={lane.key}
        initiative={lane.initiative}
        depth={lane.depth}
        childCount={lane.childCount}
        collapsed={collapsed.has(lane.initiative.initiative_id)}
        onToggle={toggle}
        slug={slug}
        editable={editable}
        range={range}
        pxPerDay={pxPerDay}
        view={view}
        onChange={change}
        onReveal={(day) => {
          scrollToDay(day, 24);
        }}
      />
    ) : (
      <ProjectLaneRow
        key={lane.key}
        project={lane.project}
        depth={lane.depth}
        slug={slug}
        range={range}
        pxPerDay={pxPerDay}
        view={view}
        onReveal={(day) => {
          scrollToDay(day, 24);
        }}
      />
    );

  const count = initiatives.length;
  return (
    <div
      ref={scroller}
      onScroll={readView}
      className="relative min-h-0 flex-1 overflow-auto"
      data-testid={testId}
    >
      <div className="relative" style={{ width: nameWidth + laneWidth }}>
        <TimelineDateHeader
          range={range}
          header={header}
          pxPerDay={pxPerDay}
          laneWidth={laneWidth}
          todayLeft={todayLeft}
          countLabel={`${String(count)} ${count === 1 ? 'initiative' : 'initiatives'}`}
        />
        <div className="relative">
          <TimelineGrid
            range={range}
            header={header}
            pxPerDay={pxPerDay}
            laneWidth={laneWidth}
            todayLeft={todayLeft}
          />
          <ul aria-label="Initiatives on the timeline">
            {lanes.dated.map(renderLane)}
          </ul>
          {lanes.undated.length > 0 && (
            <section aria-label="No dates">
              <div className="sticky top-12 z-20 flex h-8 border-b border-line bg-surface">
                <span
                  className="sticky left-0 flex shrink-0 items-center gap-2 px-4 text-sm font-medium text-text"
                  style={{ width: nameWidth }}
                >
                  No dates
                  <span className="text-xs font-normal text-text-faint tabular-nums">
                    {String(
                      lanes.undated.filter((lane) => lane.depth === 0).length
                    )}
                  </span>
                </span>
              </div>
              <ul aria-label="Initiatives with no dates">
                {lanes.undated.map(renderLane)}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default InitiativeTimeline;
