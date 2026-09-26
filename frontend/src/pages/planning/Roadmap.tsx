/**
 * The workspace roadmap: every project as a bar from its start to its target
 * date on a scrolling timeline. Dragging a bar moves both dates, dragging an
 * edge moves one, and clicking the empty lane of an undated project schedules
 * it; each change shows at once and is undone with a notice if the write
 * fails. The names stay pinned on the left, the header stays pinned on top,
 * and a bar's label follows the view so a long bar is always named.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LuArrowLeft,
  LuArrowRight,
  LuCalendarRange,
  LuMinus,
  LuPlus,
} from 'react-icons/lu';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { updateProject } from '../../api/planning';
import { TeamKey } from '../../components/planning/ProjectPickers';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import { Combobox } from '../../components/ui/combobox';
import EmptyState from '../../components/ui/empty-state';
import { Popover } from '../../components/ui/popover';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { useOptimisticRecord } from '../../lib/optimistic';
import { projectPath } from '../../lib/paths';
import {
  PROJECT_STATUS_LABELS,
  completionPercent,
} from '../../lib/planningDisplay';
import { canEditProject } from '../../lib/planningModel';
import {
  PX_PER_DAY,
  TIMELINE_ZOOMS,
  TIMELINE_ZOOM_LABELS,
  barDays,
  clampLabel,
  dayValue,
  dragBar,
  offscreenSide,
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

/** Roughly how wide a bar label is, so it can be kept in view. */
const labelWidth = (name: string): number =>
  Math.min(260, 20 + name.length * 7);

/** Orders projects by start, then target, undated last, then by name. */
const byStart = (left: ProjectRead, right: ProjectRead): number => {
  const a = left.start_date ?? left.target_date;
  const b = right.start_date ?? right.target_date;
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  }
  return left.name.localeCompare(right.name);
};

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

/** Props for RoadmapRow: one project and the timeline it sits on. */
interface RoadmapRowProps {
  project: ProjectRead;
  slug: string;
  workspaceId: string;
  teams: TeamRead[];
  people: Assignable[];
  workspaceRole: WorkspaceRole | undefined;
  range: TimelineRange;
  pxPerDay: number;
  view: ViewWindow;
  refreshKey: ReturnType<typeof useWorkspaceProjects>['queryKey'];
  onReveal: (day: number) => void;
}

/** One project's row: its name pinned left and its bar on the lane. */
const RoadmapRow: React.FC<RoadmapRowProps> = ({
  project: server,
  slug,
  workspaceId,
  teams,
  people,
  workspaceRole,
  range,
  pxPerDay,
  view,
  refreshKey,
  onReveal,
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
  const editable = canEditProject(workspaceRole, project, teams);
  const percent = completionPercent(project.counts);
  const lead = people.find((person) => person.user_id === project.lead_id);
  const href = projectPath(slug, project.project_id);
  const projectTeams = teams.filter((team) =>
    project.team_ids.includes(team.id)
  );

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
      target_date: dayValue(next.end),
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
  const dates =
    bar === null
      ? 'Not scheduled'
      : `${dayValue(bar.start)} to ${dayValue(bar.end)}`;

  return (
    <li className="group/row flex h-10 border-b border-line">
      <div
        className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-line bg-bg px-4 text-sm group-hover/row:bg-surface"
        style={{ width: NAME_WIDTH }}
      >
        <ProjectStatusGlyph status={project.status} percent={percent} />
        <Link
          to={href}
          className="min-w-0 flex-1 truncate font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {project.name}
        </Link>
        {projectTeams.slice(0, 2).map((team) => (
          <TeamKey key={team.id} keyPrefix={team.key_prefix} />
        ))}
        {lead !== undefined && (
          <span title={personLabel(lead)}>
            <Avatar name={personLabel(lead)} size="xs" />
          </span>
        )}
      </div>
      <div
        className={cn(
          'relative shrink-0',
          bar === null && editable && 'cursor-copy'
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
              title={`${project.name}\n${PROJECT_STATUS_LABELS[project.status]} · ${dates}`}
              onPointerDown={beginDrag('move')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={() => {
                setDrag(null);
              }}
              onKeyDown={onBarKey}
              className={cn(
                'absolute top-2 flex h-6 items-center overflow-visible rounded-sm border border-accent/40 bg-accent-soft text-xs text-text select-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                editable ? 'cursor-grab' : 'cursor-pointer',
                drag !== null && 'cursor-grabbing shadow-md ring-1 ring-accent'
              )}
              style={{ left, width }}
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 rounded-l-sm bg-accent/25"
                style={{ width: `${String(percent)}%` }}
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
                style={{ left: labelLeft, maxWidth: inside ? width - 16 : 260 }}
              >
                {project.name}
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
              <button
                type="button"
                aria-label={`Scroll to ${project.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onReveal(bar.start);
                }}
                className="absolute top-2.5 z-10 inline-flex h-5 items-center gap-1 rounded-xs border border-line bg-surface px-1.5 text-2xs text-text-muted hover:text-text"
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
      </div>
    </li>
  );
};

/** The workspace roadmap of projects on a timeline. */
export const Roadmap: React.FC = () => {
  const { workspace } = useWorkspace();
  const slug = workspace?.slug ?? '';
  const [params, setParams] = useSearchParams();
  const {
    teams,
    workspaceId,
    isLoading: isResolvingTeams,
    error: teamsError,
  } = useTeam(undefined);
  const teamFilter = params.get('team') ?? '';
  const filteredTeam = teams.find((team) => team.key_prefix === teamFilter);
  const zoomParam = params.get('zoom');
  const zoom: TimelineZoom = TIMELINE_ZOOMS.includes(zoomParam as TimelineZoom)
    ? (zoomParam as TimelineZoom)
    : 'month';
  const pxPerDay = PX_PER_DAY[zoom];

  const { projects, error, isLoading, queryKey } = useWorkspaceProjects(
    workspaceId,
    filteredTeam?.id ?? '',
    !isResolvingTeams && (teamFilter === '' || filteredTeam !== undefined)
  );
  const teamIds = useMemo(() => teams.map((team) => team.id), [teams]);
  const { people } = usePlanningTeamLists(workspaceId, teamIds, {
    statuses: false,
    labels: false,
  });

  const [today] = useState(() => todayNumber());
  const rows = useMemo(() => [...projects].sort(byStart), [projects]);
  const range = useMemo(
    () =>
      timelineRange(
        projects.flatMap((project) => [
          project.start_date,
          project.target_date,
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

  const hasRows = rows.length > 0;
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

  const setParam = (field: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(field);
    else next.set(field, value);
    setParams(next, { replace: true });
  };

  const stepZoom = (step: number): void => {
    const index = TIMELINE_ZOOMS.indexOf(zoom) + step;
    const next =
      TIMELINE_ZOOMS[Math.min(TIMELINE_ZOOMS.length - 1, Math.max(0, index))];
    if (next !== undefined && next !== zoom)
      setParam('zoom', next === 'month' ? '' : next);
  };

  useShortcut({
    keys: '-',
    label: 'Zoom out',
    group: 'Roadmap',
    handler: () => {
      stepZoom(1);
    },
  });
  useShortcut({
    keys: '=',
    label: 'Zoom in',
    group: 'Roadmap',
    handler: () => {
      stepZoom(-1);
    },
  });
  useShortcut({
    keys: 't',
    label: 'Scroll to today',
    group: 'Roadmap',
    handler: () => {
      scrollToDay(today);
    },
  });

  const todayLeft = (today - range.start + 0.5) * pxPerDay;
  const showSkeleton =
    teamsError === null && (isResolvingTeams || isLoading) && rows.length === 0;

  return (
    <WorkspaceShell
      title="Roadmap"
      flush
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Popover
            label="Team"
            contentClassName="w-60"
            trigger={(trigger) => (
              <button
                type="button"
                {...trigger}
                aria-label={`Team filter: ${filteredTeam?.name ?? 'All teams'}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line px-2 text-xs text-text hover:border-line-strong hover:bg-raised"
              >
                {filteredTeam === undefined ? (
                  'All teams'
                ) : (
                  <>
                    <TeamKey keyPrefix={filteredTeam.key_prefix} />
                    {filteredTeam.name}
                  </>
                )}
              </button>
            )}
          >
            {(close) => (
              <Combobox
                label="Team"
                placeholder="Filter by team"
                options={[
                  { value: '', label: 'All teams' },
                  ...teams.map((team) => ({
                    value: team.key_prefix,
                    label: team.name,
                    icon: <TeamKey keyPrefix={team.key_prefix} />,
                  })),
                ]}
                selected={[teamFilter]}
                onSelect={(value) => {
                  close();
                  setParam('team', value);
                }}
              />
            )}
          </Popover>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                scrollToDay(today);
              }}
            >
              Today
            </Button>
            <IconButton
              label="Zoom out"
              size="sm"
              disabled={zoom === 'year'}
              onClick={() => {
                stepZoom(1);
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
                    setParam('zoom', value === 'month' ? '' : value);
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
                stepZoom(-1);
              }}
            >
              <LuPlus className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>
      }
    >
      {(teamsError !== null || (error !== null && error !== undefined)) && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(
              teamsError ?? error,
              'Could not load the roadmap. Try again shortly.'
            )}
          />
        </div>
      )}
      {showSkeleton ? (
        <SkeletonRows label="Loading roadmap" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<LuCalendarRange />}
          message="No projects to plan yet. Projects show here as bars from their start to their target date."
        />
      ) : (
        <div
          ref={scroller}
          onScroll={readView}
          className="relative min-h-0 flex-1 overflow-auto"
          data-testid="roadmap-scroller"
        >
          <div className="relative" style={{ width: NAME_WIDTH + laneWidth }}>
            <div className="sticky top-0 z-30 flex border-b border-line bg-bg">
              <div
                className="sticky left-0 z-10 flex shrink-0 items-end border-r border-line bg-bg px-4 pb-1.5 text-xs text-text-muted"
                style={{ width: NAME_WIDTH }}
              >
                {`${String(rows.length)} ${rows.length === 1 ? 'project' : 'projects'}`}
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
            <div className="relative">
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
              </div>
              <ul aria-label="Projects on the roadmap">
                {rows.map((project) => (
                  <RoadmapRow
                    key={project.project_id}
                    project={project}
                    slug={slug}
                    workspaceId={workspaceId}
                    teams={teams}
                    people={people}
                    workspaceRole={workspace?.role}
                    range={range}
                    pxPerDay={pxPerDay}
                    view={view}
                    refreshKey={queryKey}
                    onReveal={(day) => {
                      scrollToDay(day, 24);
                    }}
                  />
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </WorkspaceShell>
  );
};

export default Roadmap;
