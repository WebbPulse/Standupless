/**
 * The board layout: one column per group, swimlanes when the view is
 * sub-grouped, and compact cards. Dragging a card to another column sets the
 * grouped property to that column's value, and dragging to another lane sets
 * the sub-grouped one. Dropping a card between two others writes a manual
 * position between them, and a reorder inside a column switches the view to
 * manual ordering, since any other ordering would put the card straight back.
 *
 * A drag on a selected card carries the whole selection, with a count badge
 * on the drag image, and lands it in one write with one undo entry: the same
 * column and lane for every card, placed together in their shown order at a
 * manual slot. A drag on a card outside the selection moves that card alone.
 * Cards the viewer cannot edit stay put, and the notice counts them.
 *
 * A column can be hidden from its header menu. Hidden columns sit in a rail
 * on the right, or below the board on phones, with their counts, and one
 * click previews a column's issues in a popover without showing it, with a
 * Show column action that brings it back. Each one in the rail also takes a
 * drop, which sets its value without showing it again. With empty groups
 * turned off, the empty columns join the rail after the hidden ones as drop
 * targets only, so every column stays reachable, and a drop on one brings it
 * onto the board by filling it. On touch screens the columns snap into place.
 *
 * A quiet New issue row closes each cell the viewer may create in. It shows on
 * hover or focus, and always in an empty cell, and opens the create dialog with
 * the column's value, and the lane's in swimlanes, already set.
 *
 * A click on a card opens the issue. Cmd or Ctrl+click toggles the card in
 * the selection instead, and Shift+click selects the range from the last
 * toggled card.
 *
 * Native drag and drop keeps this dependency free. The keyboard path to the
 * same writes is the property shortcuts on the focused card.
 */

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LuChevronRight, LuEllipsis, LuEyeOff, LuPlus } from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { cn } from '../../../lib/cn';
import {
  groupIssues,
  hiddenColumnKey,
  type IssueGroup,
  type ViewState,
  withinStatusCategories,
} from '../../../lib/issueView';
import type { StatusCategory } from '../../../types/Api';
import { parentRefOf } from '../../../lib/issueTree';
import { issuePath } from '../../../lib/paths';
import { IconButton } from '../../ui/button';
import { Menu, MenuItem } from '../../ui/menu';
import { Popover } from '../../ui/popover';
import { TruncatedText, useTruncationTooltip } from '../../ui/truncated-text';
import { RelationMarkers } from '../BlockedMarker';
import {
  AssigneeCell,
  MetaChips,
  PriorityCell,
  StatusCell,
} from './IssueProperties';
import HiddenColumnPreview from './HiddenColumnPreview';
import { useIssueViewEnv, useRowFocus } from './IssueViewContext';
import { ArchivedMarker, GroupFigure, GroupGlyph } from './ListRows';
import { CardParentRef } from './SubIssueCues';
import {
  draggedIds,
  isNoOpDrop,
  setCountDragImage,
} from '../../../lib/boardDrop';
import { endIssueDrag, startIssueDrag } from '../../../lib/issueDrag';
import {
  canDragIssue,
  landIssueDrop,
  type DropCell,
  type DropLanding,
} from './issueDrop';
import { useIssuePrefetch } from '../../../hooks/useIssuePrefetch';

/** Where a dragged card would land. */
interface DropTarget {
  lane: string;
  column: string;
  index: number;
}

/**
 * Where a drop lands: a slot in a cell, or a hidden column in the rail, which
 * has no lane and no slot, so each card keeps its own lane and position.
 */
type Landing = DropLanding;

/**
 * The cards being dragged, in display order, the lead card the drag started
 * on, the cell it came from and how tall it stands.
 */
interface DragSource {
  ids: string[];
  lead: string;
  lane: string;
  column: string;
  height: number;
}

/** A card's cell: its lane and column keys. */
type CellRef = DropCell;

/** The shortest placeholder drawn, for a card that reports no height. */
const MIN_PLACEHOLDER = 40;

/** Column width: 20rem, narrowed on phones so the next column peeks in. */
const COLUMN_WIDTH = 'w-[min(20rem,calc(100vw-3rem))]';

/** The lane key used when the board has no swimlanes. */
const ONE_LANE = 'all';

/** Props for BoardCard. */
interface BoardCardProps {
  issue: OrderedIssueRead;
  draggable: boolean;
  dimmed: boolean;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
}

/** One compact card. */
const BoardCard: React.FC<BoardCardProps> = ({
  issue,
  draggable,
  dimmed,
  onDragStart,
  onDragEnd,
  onDragOver,
}) => {
  const env = useIssueViewEnv();
  const shows = (property: (typeof env.state.visible)[number]): boolean =>
    env.state.visible.includes(property);
  const { focused: isFocused, peeked: isPeeked } = useRowFocus(issue);
  const isSelected = env.selected.has(issue.id);
  const prefetch = useIssuePrefetch(issue.key, isFocused);
  const parent = env.parentOf?.(issue) ?? parentRefOf(issue);
  const titleTip = useTruncationTooltip<HTMLAnchorElement>({ chain: prefetch });
  return (
    <li
      data-row-id={issue.id}
      aria-selected={isSelected}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onMouseMove={() => {
        if (!isFocused) env.focus(issue.id);
      }}
      onContextMenu={(event) => {
        if (env.openMenu === undefined) return;
        event.preventDefault();
        env.openMenu(issue, event.clientX, event.clientY);
      }}
      className={cn(
        'group/card relative flex flex-col gap-1.5 rounded-md border bg-raised px-3 py-2 shadow-xs transition-colors duration-100',
        isSelected
          ? 'border-accent bg-accent-soft'
          : isFocused || isPeeked
            ? 'border-line-strong'
            : 'border-line hover:border-line-strong hover:shadow-sm',
        dimmed && 'opacity-40',
        draggable && 'cursor-grab active:cursor-grabbing'
      )}
    >
      <div className="flex items-center gap-2">
        {shows('id') && (
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-text-faint">
            {issue.key}
          </span>
        )}
        {!shows('id') && <span className="flex-1" />}
        {shows('assignee') && <AssigneeCell issue={issue} />}
      </div>
      {parent !== undefined && (
        <CardParentRef slug={env.slug} parent={parent} />
      )}
      <div className="flex items-start gap-1.5">
        {shows('status') && env.state.groupBy !== 'status' && (
          <StatusCell issue={issue} className="-ml-1" />
        )}
        <Link
          ref={titleTip.ref}
          to={issuePath(env.slug, issue.key)}
          {...prefetch}
          {...titleTip.handlers}
          draggable={false}
          data-hover="parent"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();
              env.toggleSelected(issue.id, false);
              return;
            }
            if (event.shiftKey) {
              event.preventDefault();
              env.toggleSelected(issue.id, true);
              return;
            }
            env.onOpen?.();
          }}
          className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-text after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
        >
          {issue.title}
        </Link>
        {titleTip.tip}
        <RelationMarkers issue={issue} className="mt-0.5" />
        {(issue.archived_at ?? null) !== null && (
          <ArchivedMarker className="mt-0.5" />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {shows('priority') && env.state.groupBy !== 'priority' && (
          <PriorityCell issue={issue} className="-ml-1" />
        )}
        <MetaChips issue={issue} card />
      </div>
    </li>
  );
};

/** Props for BoardLayout. */
export interface BoardLayoutProps {
  /** The rows in display order. */
  issues: OrderedIssueRead[];
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Changes the view state, used to switch to manual ordering on a reorder. */
  onStateChange: (state: ViewState) => void;
  createIn?:
    | ((group: IssueGroup, sub?: IssueGroup) => (() => void) | undefined)
    | undefined;
  /**
   * The status categories the view's scope covers. Status columns outside
   * them are left out, even with empty columns shown.
   */
  statusCategories?: readonly StatusCategory[] | undefined;
}

/** The board. */
export const BoardLayout: React.FC<BoardLayoutProps> = ({
  issues,
  collapsed,
  onToggle,
  onStateChange,
  createIn,
  statusCategories,
}) => {
  const env = useIssueViewEnv();
  const { state, context } = env;
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [railTarget, setRailTarget] = useState<string | null>(null);

  const columnField = state.groupBy === 'none' ? 'status' : state.groupBy;
  const laneField = state.subGroupBy;

  const { columns, hidden, empty, lanes } = useMemo(() => {
    const all = withinStatusCategories(
      groupIssues(issues, columnField, context, true),
      columnField,
      statusCategories
    );
    const shown = state.showEmpty
      ? all
      : all.filter((column) => column.issues.length > 0);
    const laneGroups =
      laneField === 'none'
        ? [
            {
              key: ONE_LANE,
              field: laneField,
              label: 'All issues',
              issues,
            } satisfies IssueGroup,
          ]
        : groupIssues(issues, laneField, context, state.showEmpty);
    return {
      columns: shown.filter(
        (column) => !collapsed.has(hiddenColumnKey(column.key))
      ),
      hidden: all.filter((column) =>
        collapsed.has(hiddenColumnKey(column.key))
      ),
      empty: state.showEmpty
        ? []
        : all.filter(
            (column) =>
              column.issues.length === 0 &&
              !collapsed.has(hiddenColumnKey(column.key))
          ),
      lanes: laneGroups.map((lane) => ({
        lane,
        cells: groupIssues(lane.issues, columnField, context, true),
      })),
    };
  }, [
    issues,
    columnField,
    laneField,
    context,
    state.showEmpty,
    collapsed,
    statusCategories,
  ]);

  const byId = useMemo(
    () => new Map(issues.map((issue) => [issue.id, issue])),
    [issues]
  );

  const order = useMemo(() => issues.map((issue) => issue.id), [issues]);

  const cellOf = useMemo(() => {
    const cells = new Map<string, CellRef>();
    for (const { lane, cells: laneCells } of lanes) {
      for (const cell of laneCells) {
        for (const issue of cell.issues) {
          if (!cells.has(issue.id)) {
            cells.set(issue.id, { lane: lane.key, column: cell.key });
          }
        }
      }
    }
    return cells;
  }, [lanes]);

  const cellIssues = (lane: string, column: string): OrderedIssueRead[] =>
    lanes
      .find((item) => item.lane.key === lane)
      ?.cells.find((item) => item.key === column)?.issues ?? [];

  const editable = (issue: OrderedIssueRead): boolean =>
    canDragIssue(env, issue);

  const endDrag = (): void => {
    endIssueDrag();
    setDrag(null);
    setTarget(null);
    setRailTarget(null);
  };

  const drop = (to: Landing): void => {
    const source = drag;
    endDrag();
    if (source === null) return;
    landIssueDrop({
      env,
      onStateChange,
      movers: source.ids.flatMap((id) => {
        const issue = byId.get(id);
        return issue === undefined ? [] : [issue];
      }),
      lead: source.lead,
      source: { lane: source.lane, column: source.column },
      cellOf: (id) => cellOf.get(id),
      to,
      columnField,
      laneField,
      cellIssues,
      columnLabel: (key) =>
        [...columns, ...hidden, ...empty].find((column) => column.key === key)
          ?.label ?? key,
      laneLabel: (key) =>
        lanes.find((item) => item.lane.key === key)?.lane.label ?? key,
    });
  };

  const overCell =
    (lane: string, column: string, count: number) =>
    (event: React.DragEvent): void => {
      if (drag === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if ((event.target as HTMLElement).closest('[data-row-id]') !== null)
        return;
      if (
        target?.lane !== lane ||
        target.column !== column ||
        target.index !== count
      ) {
        setTarget({ lane, column, index: count });
      }
    };

  const overCard =
    (lane: string, column: string, index: number) =>
    (event: React.DragEvent): void => {
      if (drag === null) return;
      event.preventDefault();
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const at = event.clientY > box.top + box.height / 2 ? index + 1 : index;
      if (
        target?.lane !== lane ||
        target.column !== column ||
        target.index !== at
      ) {
        setTarget({ lane, column, index: at });
      }
    };

  const placeholder = (
    <li
      aria-hidden="true"
      data-drop-placeholder=""
      style={{ height: Math.max(drag?.height ?? 0, MIN_PLACEHOLDER) }}
      onDragOver={(event) => {
        if (drag === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
      }}
      className="shrink-0 rounded-md border border-dashed border-accent bg-accent-soft/40"
    />
  );

  const renderCell = (
    lane: IssueGroup,
    column: IssueGroup,
    cell: IssueGroup
  ) => {
    const isTarget =
      target !== null &&
      target.lane === lane.key &&
      target.column === column.key;
    const showsPlaceholder =
      isTarget &&
      drag !== null &&
      (drag.ids.length > 1 ||
        !isNoOpDrop(
          {
            lane: drag.lane,
            column: drag.column,
            from: cell.issues.findIndex((issue) => issue.id === drag.lead),
          },
          target
        ));
    const cellLabel =
      laneField === 'none' ? column.label : `${column.label}, ${lane.label}`;
    const onCreate = createIn?.(
      column,
      laneField === 'none' ? undefined : lane
    );
    const isEmpty = cell.issues.length === 0;
    return (
      <ul
        key={column.key}
        aria-label={cellLabel}
        onDragOver={overCell(lane.key, column.key, cell.issues.length)}
        onDrop={(event) => {
          event.preventDefault();
          drop(
            target ?? {
              lane: lane.key,
              column: column.key,
              index: cell.issues.length,
            }
          );
        }}
        className={cn(
          'group/cell flex shrink-0 flex-col gap-1.5 rounded-md p-1.5 transition-colors',
          COLUMN_WIDTH,
          laneField === 'none' ? 'min-h-24' : 'min-h-12',
          isTarget && drag !== null ? 'bg-surface/80' : 'bg-surface/40'
        )}
      >
        {cell.issues.map((issue, index) => (
          <React.Fragment key={issue.id}>
            {showsPlaceholder && target.index === index && placeholder}
            <BoardCard
              issue={issue}
              draggable={editable(issue)}
              dimmed={drag?.ids.includes(issue.id) ?? false}
              onDragStart={(event) => {
                const card = event.currentTarget as HTMLElement;
                const ids = draggedIds(issue.id, env.selected, order);
                event.dataTransfer.effectAllowed = 'move';
                startIssueDrag(event.dataTransfer, {
                  issues: ids.flatMap((id) => {
                    const held = byId.get(id);
                    return held === undefined ? [] : [held];
                  }),
                  canEdit: (held) => canDragIssue(env, held),
                  update: env.update,
                  queryKey: env.queryKey,
                });
                setCountDragImage(
                  event.dataTransfer,
                  card,
                  ids.length,
                  `${String(ids.length)} issues`,
                  { x: event.clientX, y: event.clientY }
                );
                setDrag({
                  ids,
                  lead: issue.id,
                  lane: lane.key,
                  column: column.key,
                  height: card.getBoundingClientRect().height,
                });
              }}
              onDragEnd={endDrag}
              onDragOver={overCard(lane.key, column.key, index)}
            />
          </React.Fragment>
        ))}
        {showsPlaceholder && target.index >= cell.issues.length && placeholder}
        {onCreate !== undefined && drag === null && (
          <li className="shrink-0">
            <button
              type="button"
              aria-label={`New issue at the end of ${cellLabel}`}
              onClick={onCreate}
              className={cn(
                'flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm text-text-faint transition-[opacity,color,background-color] duration-100 pointer-coarse:h-11 hover:bg-raised hover:text-text-muted focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent',
                isEmpty
                  ? 'opacity-100'
                  : 'opacity-0 group-focus-within/cell:opacity-100 group-hover/cell:opacity-100 pointer-coarse:opacity-100'
              )}
            >
              <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
              New issue
            </button>
          </li>
        )}
      </ul>
    );
  };

  const railEntry = (column: IssueGroup, showable: boolean) => {
    const isTarget = railTarget === column.key;
    const railClass = cn(
      'flex h-8 items-center gap-2 rounded-md border px-2 text-left text-sm pointer-coarse:h-11 transition-colors duration-100',
      showable && 'focus-visible:outline-2 focus-visible:outline-accent',
      isTarget
        ? 'border-accent bg-accent-soft text-text'
        : drag !== null
          ? 'border-dashed border-line text-text-muted'
          : showable
            ? 'border-transparent text-text-muted hover:bg-raised hover:text-text'
            : 'border-transparent text-text-faint'
    );
    const props = {
      'data-drop-target': isTarget ? '' : undefined,
      'data-empty-column': showable ? undefined : '',
      onDragOver: (event: React.DragEvent) => {
        if (drag === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (target !== null) setTarget(null);
        if (railTarget !== column.key) setRailTarget(column.key);
      },
      onDragLeave: () => {
        if (railTarget === column.key) setRailTarget(null);
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        drop({ lane: null, column: column.key, index: null });
      },
    };
    const content = (
      <>
        <GroupGlyph group={column} />
        <TruncatedText className="min-w-0 flex-1">{column.label}</TruncatedText>
        <GroupFigure issues={column.issues} requests={column.requests} />
      </>
    );
    if (!showable) {
      return (
        <div
          key={column.key}
          title={`${column.label} is empty. Drop issues here to move them to it`}
          {...props}
          className={railClass}
        >
          {content}
        </div>
      );
    }
    return (
      <Popover
        key={column.key}
        block
        label={`${column.label} issues`}
        contentClassName="w-80"
        trigger={(triggerProps) => (
          <button
            type="button"
            title={`Preview ${column.label}`}
            {...triggerProps}
            {...props}
            className={cn(railClass, 'w-full')}
          >
            {content}
          </button>
        )}
      >
        {(close) => (
          <HiddenColumnPreview
            column={column}
            onShow={() => {
              onToggle(hiddenColumnKey(column.key));
            }}
            onClose={close}
          />
        )}
      </Popover>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-h-0 flex-1 scroll-px-3 overflow-auto pointer-coarse:snap-x pointer-coarse:snap-mandatory lg:scroll-px-5">
        <div className="inline-flex min-w-full flex-col gap-0 px-3 pb-6 lg:px-5">
          <div className="sticky top-0 z-20 flex gap-2 bg-bg pt-3 pb-1.5">
            {columns.map((column) => {
              const onCreate = createIn?.(column);
              return (
                <div
                  key={column.key}
                  className={cn(
                    'group/col flex h-8 shrink-0 snap-start items-center gap-2 px-2 pointer-coarse:h-11',
                    COLUMN_WIDTH
                  )}
                >
                  <GroupGlyph group={column} />
                  <TruncatedText className="text-sm font-medium text-text">
                    {column.label}
                  </TruncatedText>
                  <GroupFigure
                    issues={column.issues}
                    requests={column.requests}
                  />
                  <span className="ml-auto flex items-center opacity-0 group-focus-within/col:opacity-100 group-hover/col:opacity-100 pointer-coarse:opacity-100">
                    <Menu
                      label={`${column.label} column`}
                      align="end"
                      trigger={(props) => (
                        <IconButton
                          {...props}
                          label={`${column.label} column options`}
                          size="sm"
                          variant="ghost"
                        >
                          <LuEllipsis className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
                    >
                      <MenuItem
                        onSelect={() => {
                          onToggle(hiddenColumnKey(column.key));
                        }}
                      >
                        <LuEyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                        Hide column
                      </MenuItem>
                    </Menu>
                    {onCreate !== undefined && (
                      <IconButton
                        label={`New issue in ${column.label}`}
                        size="sm"
                        variant="ghost"
                        onClick={onCreate}
                      >
                        <LuPlus className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {lanes.map(({ lane, cells }) => {
            const folded =
              laneField !== 'none' && collapsed.has(`lane/${lane.key}`);
            return (
              <section
                key={lane.key}
                aria-label={laneField === 'none' ? 'Board' : lane.label}
                className={cn(laneField !== 'none' && 'mt-2')}
              >
                {laneField !== 'none' && (
                  <button
                    type="button"
                    aria-expanded={!folded}
                    onClick={() => {
                      onToggle(`lane/${lane.key}`);
                    }}
                    className="sticky left-0 flex h-8 items-center gap-2 rounded-sm px-2 text-sm pointer-coarse:h-11 transition-colors duration-100 hover:bg-raised active:bg-line focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <LuChevronRight
                      aria-hidden="true"
                      className={cn(
                        'h-3.5 w-3.5 text-text-faint transition-transform duration-100',
                        !folded && 'rotate-90'
                      )}
                    />
                    <GroupGlyph group={lane} />
                    <span className="font-medium text-text">{lane.label}</span>
                    <GroupFigure
                      issues={lane.issues}
                      requests={lane.requests}
                    />
                  </button>
                )}
                {!folded && (
                  <div className="flex gap-2">
                    {columns.map((column) =>
                      renderCell(
                        lane,
                        column,
                        cells.find((cell) => cell.key === column.key) ?? {
                          ...column,
                          issues: [],
                        }
                      )
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      {hidden.length + empty.length > 0 && (
        <aside
          aria-label="Hidden columns"
          className="flex max-h-48 w-full shrink-0 flex-col gap-0.5 overflow-y-auto border-t border-line px-2 pt-3 pb-6 md:max-h-none md:w-56 md:border-t-0 md:border-l"
        >
          <p className="flex h-8 items-center px-2 text-xs font-medium text-text-muted">
            Hidden columns
          </p>
          {hidden.map((column) => railEntry(column, true))}
          {empty.map((column) => railEntry(column, false))}
        </aside>
      )}
    </div>
  );
};

export default BoardLayout;
