/**
 * The board layout: one column per group, swimlanes when the view is
 * sub-grouped, and compact cards. Dragging a card to another column sets the
 * grouped property to that column's value, and dragging to another lane sets
 * the sub-grouped one. Dropping a card between two others writes a manual
 * position between them, and a reorder inside a column switches the view to
 * manual ordering, since any other ordering would put the card straight back.
 *
 * Native drag and drop keeps this dependency free. The keyboard path to the
 * same writes is the property shortcuts on the focused card.
 */

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LuChevronRight, LuPlus } from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { cn } from '../../../lib/cn';
import {
  groupIssues,
  moveChange,
  orderKeyAt,
  type IssueChange,
  type IssueGroup,
  type ViewState,
} from '../../../lib/issueView';
import { issuePath } from '../../../lib/paths';
import { showToast } from '../../../lib/toast';
import { IconButton } from '../../ui/button';
import BlockedMarker from '../BlockedMarker';
import {
  AssigneeCell,
  MetaChips,
  PriorityCell,
  StatusCell,
} from './IssueProperties';
import { useIssueViewEnv } from './IssueViewContext';
import { GroupGlyph } from './ListRows';

/** Where a dragged card would land. */
interface DropTarget {
  lane: string;
  column: string;
  index: number;
}

/** The card being dragged and where it came from. */
interface DragSource {
  id: string;
  lane: string;
  column: string;
}

/** The lane key used when the board has no swimlanes. */
const ONE_LANE = 'all';

/** Joins two changes, adding their label edits together. */
const joinChanges = (left: IssueChange, right: IssueChange): IssueChange => {
  const merged: IssueChange = { ...left, ...right };
  const adds = [...(left.add_label_ids ?? []), ...(right.add_label_ids ?? [])];
  const removes = [
    ...(left.remove_label_ids ?? []),
    ...(right.remove_label_ids ?? []),
  ];
  if (adds.length > 0) merged.add_label_ids = adds;
  if (removes.length > 0) merged.remove_label_ids = removes;
  return merged;
};

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
  const isFocused = env.focusedId === issue.id;
  const isSelected = env.selected.has(issue.id);
  const isPeeked = env.peekedKey === issue.key;
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
      className={cn(
        'group/card relative flex flex-col gap-1.5 rounded-md border bg-raised px-3 py-2 shadow-xs transition-colors duration-100',
        isSelected
          ? 'border-accent bg-accent-soft'
          : isFocused || isPeeked
            ? 'border-line-strong'
            : 'border-line hover:border-line-strong',
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
      <div className="flex items-start gap-1.5">
        {shows('status') && env.state.groupBy !== 'status' && (
          <StatusCell issue={issue} className="-ml-1" />
        )}
        <Link
          to={issuePath(env.slug, issue.key)}
          draggable={false}
          onClick={(event) => {
            if (event.shiftKey) {
              event.preventDefault();
              env.toggleSelected(issue.id, true);
            }
          }}
          className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-text after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
        >
          {issue.title}
        </Link>
        <BlockedMarker count={issue.blocked_by_open_count} className="mt-0.5" />
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
}

/** The board. */
export const BoardLayout: React.FC<BoardLayoutProps> = ({
  issues,
  collapsed,
  onToggle,
  onStateChange,
  createIn,
}) => {
  const env = useIssueViewEnv();
  const { state, context } = env;
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  const columnField = state.groupBy === 'none' ? 'status' : state.groupBy;
  const laneField = state.subGroupBy;

  const { columns, lanes } = useMemo(() => {
    const all = groupIssues(issues, columnField, context, true);
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
      columns: shown,
      lanes: laneGroups.map((lane) => ({
        lane,
        cells: groupIssues(lane.issues, columnField, context, true),
      })),
    };
  }, [issues, columnField, laneField, context, state.showEmpty]);

  const byId = useMemo(
    () => new Map(issues.map((issue) => [issue.id, issue])),
    [issues]
  );

  const drop = (to: DropTarget): void => {
    const source = drag;
    setDrag(null);
    setTarget(null);
    if (source === null || !env.canEdit) return;
    const issue = byId.get(source.id);
    if (issue === undefined) return;

    let change: IssueChange = {};
    if (to.column !== source.column) {
      const moved = moveChange(
        issue,
        columnField,
        source.column,
        to.column,
        context
      );
      if (moved === null) {
        showToast(
          `${issue.key} cannot move there, its team has no matching value.`,
          'info'
        );
        return;
      }
      change = joinChanges(change, moved);
    }
    if (laneField !== 'none' && to.lane !== source.lane) {
      const moved = moveChange(issue, laneField, source.lane, to.lane, context);
      if (moved === null) {
        showToast(
          `${issue.key} cannot move there, its team has no matching value.`,
          'info'
        );
        return;
      }
      change = joinChanges(change, moved);
    }

    const sameCell = to.column === source.column && to.lane === source.lane;
    if (state.ordering === 'manual' || sameCell) {
      const lane = lanes.find((item) => item.lane.key === to.lane);
      const cell = lane?.cells.find((item) => item.key === to.column);
      const placed = cell?.issues ?? [];
      const from = placed.findIndex((item) => item.id === issue.id);
      const index = from >= 0 && from < to.index ? to.index - 1 : to.index;
      if (sameCell && index === from) return;
      change.sort_order = orderKeyAt(placed, index, issue.id);
      if (state.ordering !== 'manual') {
        onStateChange({ ...state, ordering: 'manual' });
      }
    }
    env.update([issue.id], change);
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

  const indicator = (
    <li aria-hidden="true" className="h-0.5 rounded-full bg-accent" />
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
    return (
      <ul
        key={column.key}
        aria-label={
          laneField === 'none' ? column.label : `${column.label}, ${lane.label}`
        }
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
          'flex w-80 shrink-0 flex-col gap-1.5 rounded-md p-1.5 transition-colors',
          laneField === 'none' ? 'min-h-24' : 'min-h-12',
          isTarget && drag !== null ? 'bg-surface/80' : 'bg-surface/40'
        )}
      >
        {cell.issues.map((issue, index) => (
          <React.Fragment key={issue.id}>
            {isTarget && target.index === index && indicator}
            <BoardCard
              issue={issue}
              draggable={env.canEdit}
              dimmed={drag?.id === issue.id}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', issue.key);
                setDrag({ id: issue.id, lane: lane.key, column: column.key });
              }}
              onDragEnd={() => {
                setDrag(null);
                setTarget(null);
              }}
              onDragOver={overCard(lane.key, column.key, index)}
            />
          </React.Fragment>
        ))}
        {isTarget && target.index >= cell.issues.length && indicator}
      </ul>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="inline-flex min-w-full flex-col gap-0 px-3 pb-6 lg:px-5">
        <div className="sticky top-0 z-20 flex gap-2 bg-bg pt-3 pb-1.5">
          {columns.map((column) => {
            const onCreate = createIn?.(column);
            return (
              <div
                key={column.key}
                className="group/col flex h-8 w-80 shrink-0 items-center gap-2 px-2"
              >
                <GroupGlyph group={column} />
                <span className="truncate text-sm font-medium text-text">
                  {column.label}
                </span>
                <span className="text-xs text-text-faint tabular-nums">
                  {column.issues.length}
                </span>
                {onCreate !== undefined && (
                  <IconButton
                    label={`New issue in ${column.label}`}
                    size="sm"
                    variant="ghost"
                    className="ml-auto opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100"
                    onClick={onCreate}
                  >
                    <LuPlus className="h-3.5 w-3.5" />
                  </IconButton>
                )}
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
                  className="sticky left-0 flex h-8 items-center gap-2 rounded-sm px-2 text-sm focus-visible:outline-2 focus-visible:outline-accent"
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
                  <span className="text-xs text-text-faint tabular-nums">
                    {lane.issues.length}
                  </span>
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
  );
};

export default BoardLayout;
