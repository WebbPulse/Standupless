/**
 * The projects page's board: one column per group, swimlanes when the page
 * groups rows too, and a card per project carrying the properties the Display
 * menu keeps on.
 *
 * A card edits in place: its status, health, priority, lead and date chips
 * are the same pickers the list rows use, and a right click or the card's
 * hover button opens a menu that reaches every property, shown or not. Every
 * edit and every drop goes through the board's optimistic move, and a change
 * that closes a project with open issues first asks what to do with them.
 *
 * Dragging a card to another column changes the field the columns are by, and
 * to another lane the field the lanes are by, so one drop can change both.
 * Team columns and lanes show where a project sits but take no drops, since a
 * project can be on several teams. Dropping a card among the others in its own
 * cell reorders it, writing the shared manual rank and switching the page to
 * manual ordering; under manual ordering a drop into another cell lands where
 * it was dropped too.
 *
 * A column header's menu creates a project already in that column, collapses
 * the column to a narrow strip that still takes drops, hides it, or hides
 * every other column. Hidden columns wait in a rail with their counts, and
 * the board remembers what was folded or hidden for each grouping.
 *
 * Cards take part in the page's selection: the card under the pointer is the
 * one x picks, a Shift click picks the run from the last one, and a selected
 * card is drawn in the accent.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LuChevronRight,
  LuEllipsis,
  LuEye,
  LuEyeOff,
  LuMinimize2,
  LuPlus,
} from 'react-icons/lu';
import { Link } from 'react-router-dom';
import CloseProjectDialog, { type ClosingStatus } from './CloseProjectDialog';
import ProgressRing from './ProgressRing';
import ProjectCardMenu from './ProjectCardMenu';
import ProjectGroupGlyph from './ProjectGroupGlyph';
import ProjectDependencyMarkers from './ProjectDependencyMarkers';
import ProjectIcon from './ProjectIcon';
import {
  HealthPicker,
  LeadPicker,
  MembersPicker,
  ProjectLabelsPicker,
  ProjectStatusPicker,
  TeamKey,
} from './ProjectPickers';
import { openPropertyChip } from './ProjectPropertyKeys';
import UpdateDueBadge from './UpdateDueBadge';
import { DatePicker, PriorityPicker } from '../issues/PropertyPickers';
import { IconButton } from '../ui/button';
import { Menu, MenuItem } from '../ui/menu';
import { useTruncationTooltip } from '../ui/truncated-text';
import type { PopoverTriggerProps } from '../ui/popover';
import {
  asksAboutOpenIssues,
  moveTargets,
  openIssueCount,
} from '../../hooks/useCloseProjectPrompt';
import { useStoredSet } from '../../hooks/useStoredSet';
import { cn } from '../../lib/cn';
import { slotIndex } from '../../lib/dropSlot';
import type { Assignable } from '../../lib/issuePeople';
import { projectPath } from '../../lib/paths';
import { progressPercent } from '../../lib/planningDisplay';
import { canEditProject } from '../../lib/planningModel';
import {
  cellChange,
  manualPlacements,
  type ProjectColumn,
  type ProjectGroup,
  type ProjectGrouping,
  type ProjectMove,
  type ProjectOrdering,
} from '../../lib/projectList';
import { shortDateLabel } from '../../lib/propertyOptions';
import type {
  ProjectLabelRead,
  ProjectOpenIssues,
  ProjectRead,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';

/** The properties a card carries when the page names none. */
const DEFAULT_CARD_PROPERTIES: readonly ProjectColumn[] = [
  'health',
  'priority',
  'target',
  'teams',
  'lead',
  'progress',
];

/** The card property each picker field draws, for a field the menu asks for. */
const FIELD_COLUMNS: Record<string, ProjectColumn> = {
  Status: 'status',
  Priority: 'priority',
  Lead: 'lead',
  Members: 'members',
  Health: 'health',
  'Start date': 'start',
  'Target date': 'target',
};

/** Column width: 18rem, narrowed on phones so the next column peeks in. */
const COLUMN_WIDTH = 'w-[min(18rem,calc(100vw-3rem))]';

/** A collapsed column's width. */
const FOLDED_WIDTH = 'w-10';

/** The lane key used when the board has no swimlanes. */
const ONE_LANE = 'all';

/** Lifts a card control above the link that covers the card. */
const ON_CARD = 'relative z-10 flex shrink-0 items-center';

/** The labels a board drawn without any are given, one array so memoised cards keep it. */
const NO_PROJECT_LABELS: ProjectLabelRead[] = [];

/** The stored key that hides a column. */
const hiddenKey = (column: string): string => `hidden/${column}`;

/** The stored key that collapses a column. */
const collapsedKey = (column: string): string => `collapsed/${column}`;

/** The stored key that folds a swimlane. */
const laneKey = (lane: string): string => `lane/${lane}`;

/** A picker the card menu asked a card to open. */
interface ForcedField {
  projectId: string;
  field: string;
}

/** Props for BoardCard: one project, how it is dragged and how it changes. */
interface BoardCardProps {
  project: ProjectRead;
  /** Every loaded project by id, so the dependency flags can name their projects. */
  byId: ReadonlyMap<string, ProjectRead>;
  shown: readonly ProjectColumn[];
  slug: string;
  teams: TeamRead[];
  people: Assignable[];
  projectLabels: ProjectLabelRead[];
  editable: boolean;
  dimmed: boolean;
  /** The picker the card menu asked for, drawn even when the card hides it. */
  forced: ForcedField | null;
  onChange: (change: ProjectMove) => void;
  onMenu: (x: number, y: number) => void;
  onForcedDone: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  /** Whether the page has the card selected. */
  selected: boolean;
  /** Whether the card is the one in focus. */
  focused: boolean;
  /** Picks or drops the card, or the run from the last pick with `range`. */
  onSelect?: ((range: boolean) => void) | undefined;
  /** Puts the card in focus, as the pointer does. */
  onFocus?: (() => void) | undefined;
}

/** One project as a board card that opens the project and edits in place. */
const BoardCard: React.FC<BoardCardProps> = ({
  project,
  byId,
  shown,
  slug,
  teams,
  people,
  projectLabels,
  editable,
  dimmed,
  forced,
  onChange,
  onMenu,
  onForcedDone,
  onDragStart,
  onDragEnd,
  selected,
  focused,
  onSelect,
  onFocus,
}) => {
  const card = useRef<HTMLLIElement>(null);
  const nameTip = useTruncationTooltip<HTMLAnchorElement>();
  const percent = progressPercent(project);
  const projectTeams = teams.filter((team) =>
    project.team_ids.includes(team.id)
  );
  const forcedColumn =
    forced === null ? undefined : FIELD_COLUMNS[forced.field];
  const has = (column: ProjectColumn): boolean =>
    shown.includes(column) || forcedColumn === column;
  const summary =
    shown.includes('summary') && project.description !== null
      ? (project.description.split('\n')[0] ?? '')
      : '';

  useEffect(() => {
    if (forced === null) return;
    openPropertyChip(card.current, forced.field);
  }, [forced]);

  const dateTrigger =
    (field: string, value: string | null) =>
    (trigger: PopoverTriggerProps): React.ReactNode => {
      const text = value === null ? 'No date' : shortDateLabel(value);
      return (
        <button
          type="button"
          disabled={!editable}
          aria-label={`${field}: ${text}`}
          {...trigger}
          className={cn(
            'h-6 rounded-sm px-1 whitespace-nowrap tabular-nums transition-colors duration-100 select-none enabled:hover:bg-raised enabled:hover:text-text disabled:cursor-default',
            value === null && 'text-text-faint'
          )}
        >
          {text}
        </button>
      );
    };

  return (
    <li
      ref={card}
      data-project-id={project.project_id}
      aria-selected={selected}
      draggable={editable}
      onMouseMove={() => {
        if (!focused) onFocus?.();
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      onBlur={(event) => {
        if (forced === null) return;
        if (event.currentTarget.contains(event.relatedTarget)) return;
        onForcedDone();
      }}
      className={cn(
        'group/card relative flex flex-col gap-2 rounded-md border border-line bg-raised px-3 py-2 shadow-xs transition-colors duration-100 hover:border-line-strong hover:shadow-sm',
        dimmed && 'opacity-40',
        editable && 'cursor-grab active:cursor-grabbing',
        selected && 'border-accent bg-accent-soft hover:border-accent',
        focused && !selected && 'border-line-strong'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ProjectIcon icon={project.icon} color={project.color} />
        <Link
          ref={nameTip.ref}
          to={projectPath(slug, project.project_id)}
          draggable={false}
          data-hover="parent"
          {...nameTip.handlers}
          onClick={(event) => {
            if (event.shiftKey && onSelect !== undefined) {
              event.preventDefault();
              onSelect(true);
            }
          }}
          className="min-w-0 flex-1 truncate text-sm font-medium text-text after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
        >
          {project.name}
        </Link>
        {nameTip.tip}
        {project.archived_at != null && (
          <span className="shrink-0 rounded border border-line px-1 text-[11px] text-text-muted">
            Archived
          </span>
        )}
        {shown.includes('dependencies') && (
          <ProjectDependencyMarkers project={project} byId={byId} />
        )}
        <UpdateDueBadge project={project} className="shrink-0" />
        <span
          className={cn(
            ON_CARD,
            '-my-1 -mr-1.5 opacity-0 transition-opacity duration-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100'
          )}
        >
          <IconButton
            label={`Actions for ${project.name}`}
            size="sm"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onMenu(box.left, box.bottom + 4);
            }}
          >
            <LuEllipsis className="h-3.5 w-3.5" />
          </IconButton>
        </span>
      </div>
      {summary !== '' && (
        <p className="truncate text-xs text-text-faint">{summary}</p>
      )}
      {has('labels') && (editable || (project.label_ids ?? []).length > 0) && (
        <div className={cn(ON_CARD, 'min-w-0 flex-wrap self-start')}>
          <ProjectLabelsPicker
            inline
            value={project.label_ids ?? []}
            labels={projectLabels}
            disabled={!editable}
            className="flex-wrap"
            onChange={(labelIds) => {
              onChange({ label_ids: labelIds });
            }}
          />
        </div>
      )}
      <div className="-ml-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-xs text-text-muted">
        {has('status') && (
          <span className={ON_CARD}>
            <ProjectStatusPicker
              variant="icon"
              value={project.status}
              percent={percent}
              disabled={!editable}
              onChange={(status) => {
                onChange({ status });
              }}
            />
          </span>
        )}
        {has('health') && (
          <span className={ON_CARD}>
            <HealthPicker
              variant="icon"
              value={project.health}
              disabled={!editable}
              onChange={(health) => {
                onChange({ health });
              }}
            />
          </span>
        )}
        {has('priority') && (
          <span className={ON_CARD}>
            <PriorityPicker
              variant="icon"
              value={project.priority}
              disabled={!editable}
              onChange={(priority) => {
                onChange({ priority });
              }}
            />
          </span>
        )}
        {has('start') && (
          <span className={ON_CARD}>
            <DatePicker
              field="Start date"
              value={project.start_date}
              disabled={!editable}
              {...(project.target_date === null
                ? {}
                : { max: project.target_date })}
              renderTrigger={dateTrigger('Start date', project.start_date)}
              onChange={(start) => {
                onChange({ start_date: start });
              }}
            />
          </span>
        )}
        {has('target') && (
          <span className={ON_CARD}>
            <DatePicker
              field="Target date"
              value={project.target_date}
              disabled={!editable}
              {...(project.start_date === null
                ? {}
                : { min: project.start_date })}
              renderTrigger={dateTrigger('Target date', project.target_date)}
              onChange={(target) => {
                onChange({ target_date: target });
              }}
            />
          </span>
        )}
        {has('teams') && (
          <span className="flex min-w-0 items-center gap-1 px-0.5">
            {projectTeams.slice(0, 2).map((team) => (
              <TeamKey key={team.id} keyPrefix={team.key_prefix} />
            ))}
          </span>
        )}
        {has('id') && (
          <span className="px-0.5 font-mono whitespace-nowrap">
            <span className="sr-only">ID </span>
            {project.slug_id ?? project.project_id.slice(-8).toLowerCase()}
          </span>
        )}
        {has('issues') && (
          <span className="px-0.5 whitespace-nowrap tabular-nums">
            <span aria-hidden="true">{`${String(project.counts.done)}/${String(project.counts.total)}`}</span>
            <span className="sr-only">{`${String(project.counts.done)} of ${String(project.counts.total)} issues done`}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 tabular-nums">
          {has('members') && (
            <span className={ON_CARD}>
              <MembersPicker
                variant="icon"
                value={project.member_ids}
                people={people}
                disabled={!editable}
                align="end"
                onChange={(memberIds) => {
                  onChange({ member_ids: memberIds });
                }}
              />
            </span>
          )}
          {has('lead') && (
            <span className={ON_CARD}>
              <LeadPicker
                variant="icon"
                value={project.lead_id}
                people={people}
                disabled={!editable}
                align="end"
                onChange={(leadId) => {
                  onChange({ lead_id: leadId });
                }}
              />
            </span>
          )}
          {has('progress') && (
            <span className="flex items-center gap-1.5 pl-0.5">
              <ProgressRing percent={percent} />
              <span>{`${String(percent)}%`}</span>
            </span>
          )}
        </span>
      </div>
    </li>
  );
};

/** Props for ProjectsBoard: the columns, the lanes and what a change needs. */
export interface ProjectsBoardProps {
  columns: ProjectGroup[];
  /** The swimlanes, or undefined for a board without them. */
  lanes?: ProjectGroup[] | undefined;
  /** The field the columns are by, which keys the remembered column state. */
  grouping: ProjectGrouping;
  /** Every project the caller sees, for the close dialog's move targets. */
  projects: ProjectRead[];
  /** The properties each card carries, in drawing order. */
  shown?: readonly ProjectColumn[] | undefined;
  slug: string;
  workspaceId: string;
  teams: TeamRead[];
  people: Assignable[];
  /** The workspace's project labels, for the label chips and picker. */
  projectLabels?: ProjectLabelRead[];
  workspaceRole: WorkspaceRole | undefined;
  onMove: (
    project: ProjectRead,
    change: ProjectMove,
    openIssues?: ProjectOpenIssues
  ) => void;
  /** The create action for a column, or undefined where it offers none. */
  createIn?: ((column: ProjectGroup) => (() => void) | undefined) | undefined;
  /** The ordering in force, which decides whether a drop keeps its position. */
  ordering?: ProjectOrdering | undefined;
  /** Switches the page's ordering, called with manual after a reorder. */
  onOrderingChange?: ((ordering: ProjectOrdering) => void) | undefined;
  /** The projects the page has selected. */
  selected?: ReadonlySet<string> | undefined;
  /** The project in focus, the one x picks. */
  focusedId?: string | null | undefined;
  /** Picks or drops a project, or the run from the last pick with `range`. */
  onToggleSelect?: ((projectId: string, range: boolean) => void) | undefined;
  /** Puts a project in focus. */
  onFocusProject?: ((projectId: string) => void) | undefined;
}

/** A card being dragged. */
interface BoardDrag {
  projectId: string;
}

/** Where a dragged card would land: its cell and its index among the other cards. */
interface BoardSlot {
  cell: string;
  index: number;
}

/** A close waiting on the open issue question. */
interface PendingClose {
  project: ProjectRead;
  status: ClosingStatus;
  change: ProjectMove;
}

/** The card menu as opened: whose and where. */
interface OpenMenu {
  projectId: string;
  x: number;
  y: number;
}

/** The board of project cards in columns and swimlanes. */
export const ProjectsBoard: React.FC<ProjectsBoardProps> = ({
  columns,
  lanes,
  grouping,
  projects,
  shown = DEFAULT_CARD_PROPERTIES,
  slug,
  workspaceId,
  teams,
  people,
  projectLabels = NO_PROJECT_LABELS,
  workspaceRole,
  onMove,
  createIn,
  ordering,
  onOrderingChange,
  selected,
  focusedId = null,
  onToggleSelect,
  onFocusProject,
}) => {
  const [drag, setDrag] = useState<BoardDrag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [slot, setSlot] = useState<BoardSlot | null>(null);
  const [closing, setClosing] = useState<PendingClose | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [forced, setForced] = useState<ForcedField | null>(null);
  const [stored, toggle] = useStoredSet(
    `standupless.projects.board.${workspaceId}.${grouping}`
  );

  const byId = useMemo(
    () => new Map(projects.map((project) => [project.project_id, project])),
    [projects]
  );

  const visible = columns.filter(
    (column) => !stored.has(hiddenKey(column.key))
  );
  const hidden = columns.filter((column) => stored.has(hiddenKey(column.key)));
  const hasLanes = lanes !== undefined && lanes.length > 0;
  const rows = useMemo(
    (): { lane: ProjectGroup; ids: ReadonlySet<string> | null }[] =>
      lanes !== undefined && lanes.length > 0
        ? lanes.map((lane) => ({
            lane,
            ids: new Set(lane.rows.map((project) => project.project_id)),
          }))
        : [
            {
              lane: {
                key: ONE_LANE,
                label: 'Projects',
                kind: 'none',
                rows: projects,
              },
              ids: null,
            },
          ],
    [lanes, projects]
  );

  const dragged =
    drag === null
      ? undefined
      : projects.find((project) => project.project_id === drag.projectId);

  const cellGroups = (
    column: ProjectGroup,
    lane: ProjectGroup
  ): ProjectGroup[] => (lane.key === ONE_LANE ? [column] : [column, lane]);

  const reorders = onOrderingChange !== undefined;

  const accepts = (column: ProjectGroup, lane: ProjectGroup): boolean => {
    if (dragged === undefined) return false;
    const patch = cellChange(dragged, cellGroups(column, lane));
    if (patch === null) return false;
    return Object.keys(patch).length > 0 || reorders;
  };

  const placesAt = (column: ProjectGroup, lane: ProjectGroup): boolean => {
    if (dragged === undefined || !reorders) return false;
    const patch = cellChange(dragged, cellGroups(column, lane));
    return (
      patch !== null &&
      (Object.keys(patch).length === 0 || ordering === 'manual')
    );
  };

  const cellCards = (
    column: ProjectGroup,
    ids: ReadonlySet<string> | null
  ): ProjectRead[] =>
    ids === null
      ? column.rows
      : column.rows.filter((project) => ids.has(project.project_id));

  const change = (project: ProjectRead, patch: ProjectMove): void => {
    if (
      patch.status !== undefined &&
      asksAboutOpenIssues(project, patch.status)
    ) {
      setClosing({ project, status: patch.status, change: patch });
      return;
    }
    onMove(project, patch);
  };

  const drop = (
    column: ProjectGroup,
    lane: ProjectGroup,
    ids: ReadonlySet<string> | null,
    index: number | null
  ): void => {
    const project = dragged;
    const positioned = placesAt(column, lane);
    setDrag(null);
    setOver(null);
    setSlot(null);
    if (project === undefined) return;
    const patch = cellChange(project, cellGroups(column, lane));
    if (patch === null) return;
    const moves = Object.keys(patch).length > 0;
    if (!positioned || index === null) {
      if (moves) change(project, patch);
      return;
    }
    const cards = cellCards(column, ids);
    const rows = cards.some((card) => card.project_id === project.project_id)
      ? cards
      : [...cards, project];
    const placements = manualPlacements(rows, project.project_id, index) ?? [];
    const own = placements.find(
      (placement) => placement.projectId === project.project_id
    );
    for (const placement of placements) {
      if (placement === own) continue;
      const other = byId.get(placement.projectId);
      if (other !== undefined)
        onMove(other, { sort_order: placement.sort_order });
    }
    const merged =
      own === undefined ? patch : { ...patch, sort_order: own.sort_order };
    if (Object.keys(merged).length > 0) change(project, merged);
    if (!moves && placements.length > 0 && ordering !== 'manual')
      onOrderingChange?.('manual');
  };

  const showOnly = (column: ProjectGroup): void => {
    for (const other of visible) {
      if (other.key !== column.key) toggle(hiddenKey(other.key));
    }
    if (stored.has(collapsedKey(column.key))) toggle(collapsedKey(column.key));
  };

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);
  const menuProject = menu === null ? undefined : byId.get(menu.projectId);

  const dropHandlers = (
    column: ProjectGroup,
    lane: ProjectGroup,
    ids: ReadonlySet<string> | null
  ) => {
    const cell = `${lane.key}|${column.key}`;
    const index = slot?.cell === cell ? slot.index : null;
    return {
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        if (!accepts(column, lane)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (over !== cell) setOver(cell);
        if (dragged === undefined || !placesAt(column, lane)) return;
        const next = slotIndex(
          event.currentTarget,
          dragged.project_id,
          event.clientY
        );
        if (index !== next) setSlot({ cell, index: next });
      },
      onDragLeave: (event: React.DragEvent) => {
        if (
          over === cell &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        ) {
          setOver(null);
          setSlot(null);
        }
      },
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        event.preventDefault();
        const at =
          dragged === undefined
            ? index
            : (index ??
              slotIndex(
                event.currentTarget,
                dragged.project_id,
                event.clientY
              ));
        drop(column, lane, ids, at);
      },
      isTarget: over === cell && accepts(column, lane),
      index,
    };
  };

  const renderCell = (
    column: ProjectGroup,
    lane: ProjectGroup,
    ids: ReadonlySet<string> | null
  ): React.ReactNode => {
    const { isTarget, index, ...handlers } = dropHandlers(column, lane, ids);
    const label =
      lane.key === ONE_LANE
        ? `${column.label} projects`
        : `${column.label}, ${lane.label} projects`;
    const cards = cellCards(column, ids);
    const others = cards.filter(
      (project) => project.project_id !== drag?.projectId
    );
    const marker =
      isTarget && index !== null && placesAt(column, lane)
        ? (others[index]?.project_id ?? null)
        : undefined;
    const placeholder = (
      <li
        key="drop-placeholder"
        aria-hidden="true"
        className="h-10 shrink-0 rounded-md border border-dashed border-accent bg-accent-soft/40"
      />
    );
    if (stored.has(collapsedKey(column.key))) {
      return (
        <div
          key={column.key}
          role="group"
          aria-label={label}
          {...handlers}
          className={cn(
            'flex shrink-0 justify-center rounded-md py-2 transition-colors',
            FOLDED_WIDTH,
            lane.key === ONE_LANE ? 'min-h-24' : 'min-h-12',
            isTarget ? 'bg-surface/80 ring-1 ring-accent/40' : 'bg-surface/40'
          )}
        >
          <span
            aria-hidden="true"
            className="text-xs text-text-faint tabular-nums [writing-mode:vertical-rl]"
          >
            {String(cards.length)}
          </span>
        </div>
      );
    }
    return (
      <ul
        key={column.key}
        aria-label={label}
        {...handlers}
        className={cn(
          'flex shrink-0 flex-col gap-1.5 rounded-md p-1.5 transition-colors',
          COLUMN_WIDTH,
          lane.key === ONE_LANE ? 'min-h-24 flex-1' : 'min-h-12',
          isTarget ? 'bg-surface/80 ring-1 ring-accent/40' : 'bg-surface/40'
        )}
      >
        {cards.map((project) => (
          <React.Fragment key={project.project_id}>
            {marker === project.project_id && placeholder}
            <BoardCard
              project={project}
              byId={byId}
              shown={shown}
              slug={slug}
              teams={teams}
              people={people}
              projectLabels={projectLabels}
              editable={canEditProject(workspaceRole, project, teams)}
              dimmed={drag?.projectId === project.project_id}
              forced={forced?.projectId === project.project_id ? forced : null}
              onChange={(patch) => {
                change(project, patch);
              }}
              onMenu={(x, y) => {
                setMenu({ projectId: project.project_id, x, y });
              }}
              onForcedDone={() => {
                setForced(null);
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', project.name);
                setDrag({ projectId: project.project_id });
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
                setSlot(null);
              }}
              selected={selected?.has(project.project_id) === true}
              focused={focusedId === project.project_id}
              onSelect={
                onToggleSelect === undefined
                  ? undefined
                  : (range) => {
                      onToggleSelect(project.project_id, range);
                    }
              }
              onFocus={
                onFocusProject === undefined
                  ? undefined
                  : () => {
                      onFocusProject(project.project_id);
                    }
              }
            />
          </React.Fragment>
        ))}
        {marker === null && placeholder}
      </ul>
    );
  };

  const header = (column: ProjectGroup): React.ReactNode => {
    const onCreate = createIn?.(column);
    if (stored.has(collapsedKey(column.key))) {
      return (
        <button
          key={column.key}
          type="button"
          aria-label={`Expand ${column.label} column`}
          title={column.label}
          onClick={() => {
            toggle(collapsedKey(column.key));
          }}
          className={cn(
            'flex h-8 shrink-0 snap-start items-center justify-center rounded-md transition-colors duration-100 pointer-coarse:h-11 hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent',
            FOLDED_WIDTH
          )}
        >
          <ProjectGroupGlyph group={column} teams={teams} />
        </button>
      );
    }
    return (
      <div
        key={column.key}
        className={cn(
          'group/col flex h-8 shrink-0 snap-start items-center gap-2 px-2 pointer-coarse:h-11',
          COLUMN_WIDTH
        )}
      >
        <ProjectGroupGlyph group={column} teams={teams} />
        <span className="truncate text-sm font-medium text-text">
          {column.label}
        </span>
        <span className="text-xs text-text-faint tabular-nums">
          {String(column.rows.length)}
        </span>
        <span className="ml-auto flex items-center opacity-0 group-focus-within/col:opacity-100 group-hover/col:opacity-100 pointer-coarse:opacity-100">
          <Menu
            label={`${column.label} column`}
            align="end"
            trigger={(props) => (
              <IconButton
                {...props}
                label={`${column.label} column options`}
                size="sm"
              >
                <LuEllipsis className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            {onCreate !== undefined && (
              <MenuItem onSelect={onCreate}>
                <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
                New project
              </MenuItem>
            )}
            <MenuItem
              onSelect={() => {
                toggle(collapsedKey(column.key));
              }}
            >
              <LuMinimize2 aria-hidden="true" className="h-3.5 w-3.5" />
              Collapse column
            </MenuItem>
            <MenuItem
              onSelect={() => {
                toggle(hiddenKey(column.key));
              }}
            >
              <LuEyeOff aria-hidden="true" className="h-3.5 w-3.5" />
              Hide column
            </MenuItem>
            {visible.length > 1 && (
              <MenuItem
                onSelect={() => {
                  showOnly(column);
                }}
              >
                <LuEye aria-hidden="true" className="h-3.5 w-3.5" />
                Show only this column
              </MenuItem>
            )}
          </Menu>
          {onCreate !== undefined && (
            <IconButton
              label={`New project in ${column.label}`}
              size="sm"
              onClick={onCreate}
            >
              <LuPlus className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-h-0 flex-1 scroll-px-3 overflow-auto pointer-coarse:snap-x pointer-coarse:snap-mandatory lg:scroll-px-5">
        <div
          className={cn(
            'inline-flex min-w-full flex-col px-3 pb-6 lg:px-5',
            !hasLanes && 'min-h-full'
          )}
        >
          <div className="sticky top-0 z-20 flex gap-2 bg-bg pt-3 pb-1.5">
            {visible.map(header)}
          </div>
          {rows.map(({ lane, ids }) => {
            const folded = hasLanes && stored.has(laneKey(lane.key));
            return (
              <section
                key={lane.key}
                aria-label={hasLanes ? lane.label : 'Board'}
                className={cn(hasLanes ? 'mt-2' : 'flex flex-1 flex-col')}
              >
                {hasLanes && (
                  <button
                    type="button"
                    aria-expanded={!folded}
                    onClick={() => {
                      toggle(laneKey(lane.key));
                    }}
                    className="sticky left-0 flex h-8 items-center gap-2 rounded-sm px-2 text-sm transition-colors duration-100 pointer-coarse:h-11 hover:bg-raised active:bg-line focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <LuChevronRight
                      aria-hidden="true"
                      className={cn(
                        'h-3.5 w-3.5 text-text-faint transition-transform duration-100',
                        !folded && 'rotate-90'
                      )}
                    />
                    <ProjectGroupGlyph group={lane} teams={teams} />
                    <span className="font-medium text-text">{lane.label}</span>
                    <span className="text-xs text-text-faint tabular-nums">
                      {String(lane.rows.length)}
                    </span>
                  </button>
                )}
                {!folded && (
                  <div className={cn('flex gap-2', !hasLanes && 'flex-1')}>
                    {visible.map((column) => renderCell(column, lane, ids))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      {hidden.length > 0 && (
        <aside
          aria-label="Hidden columns"
          className="flex max-h-48 w-full shrink-0 flex-col gap-0.5 overflow-y-auto border-t border-line px-2 pt-3 pb-6 md:max-h-none md:w-56 md:border-t-0 md:border-l"
        >
          <p className="flex h-8 items-center px-2 text-xs font-medium text-text-muted">
            Hidden columns
          </p>
          {hidden.map((column) => (
            <button
              key={column.key}
              type="button"
              aria-label={`Show ${column.label}`}
              onClick={() => {
                toggle(hiddenKey(column.key));
              }}
              className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm text-text-muted pointer-coarse:h-11 hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              <ProjectGroupGlyph group={column} teams={teams} />
              <span className="min-w-0 flex-1 truncate">{column.label}</span>
              <span className="text-xs text-text-faint tabular-nums">
                {String(column.rows.length)}
              </span>
            </button>
          ))}
        </aside>
      )}
      {menu !== null && menuProject !== undefined && (
        <ProjectCardMenu
          project={menuProject}
          slug={slug}
          x={menu.x}
          y={menu.y}
          editable={canEditProject(workspaceRole, menuProject, teams)}
          onEdit={(field) => {
            setForced({ projectId: menuProject.project_id, field });
          }}
          onClose={closeMenu}
        />
      )}
      {closing !== null && (
        <CloseProjectDialog
          project={closing.project}
          status={closing.status}
          openIssues={openIssueCount(closing.project)}
          targets={moveTargets(closing.project, projects)}
          onConfirm={(choice) => {
            onMove(closing.project, closing.change, choice);
            setClosing(null);
          }}
          onClose={() => {
            setClosing(null);
          }}
        />
      )}
    </div>
  );
};

export default ProjectsBoard;
