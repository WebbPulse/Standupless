/**
 * What a drop of dragged issues writes, shared by the board and the list so
 * both land a drag the same way. Columns are the grouped property and lanes
 * the sub-grouped one: the board draws them as columns and swimlanes, the
 * list as groups and sub-groups. A drop sets each property the issues cross,
 * places them together at a manual slot when the view is in manual order or
 * the drop stays in one cell, and lands everything in one write with one undo
 * entry. Issues the viewer cannot edit, or whose team has no matching value,
 * stay put and the notice counts them.
 */

import type { OrderedIssueRead } from '../../../api/issues';
import {
  issueCount,
  movedNotice,
  skippedNotice,
} from '../../../lib/bulkIssueActions';
import { slotPlacements, type OrderedRow } from '../../../lib/boardDrop';
import {
  customerMove,
  GROUP_LABELS,
  isLabelGroupField,
  isMovableGroupField,
  moveChange,
  type CustomerMove,
  type GroupField,
  type IssueChange,
  type ViewState,
} from '../../../lib/issueView';
import { showToast } from '../../../lib/toast';
import type { IssueViewEnv } from './IssueViewContext';

/** An issue's cell: its lane and column keys. */
export interface DropCell {
  lane: string;
  column: string;
}

/**
 * Where a drop lands: a slot in a cell, or a whole column, such as a hidden
 * board column or a list group's header, which has no lane and no slot, so
 * each issue keeps its own lane and position.
 */
export interface DropLanding {
  lane: string | null;
  column: string;
  index: number | null;
}

/** What {@link landIssueDrop} reads. */
export interface IssueDrop {
  env: Pick<
    IssueViewEnv,
    'canEdit' | 'canEditIssue' | 'context' | 'state' | 'update' | 'moveCustomer'
  >;
  /** Changes the view state, used to switch to manual ordering on a reorder. */
  onStateChange: (state: ViewState) => void;
  /** The dragged issues, in display order. */
  movers: readonly OrderedIssueRead[];
  /** The issue the drag started on. */
  lead: string;
  /** The cell the lead issue was dragged from. */
  source: DropCell;
  /** The cell every other dragged issue sits in. */
  cellOf: (id: string) => DropCell | undefined;
  to: DropLanding;
  columnField: GroupField;
  laneField: GroupField;
  /** A cell's issues as shown, which a slot index counts. */
  cellIssues: (lane: string, column: string) => readonly OrderedRow[];
  columnLabel: (key: string) => string;
  laneLabel: (key: string) => string;
}

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

/**
 * Why a drop was refused: a column the grouping cannot set by dragging, or a
 * value the issue's own team does not have.
 */
const refusedMove = (key: string, field: GroupField): string =>
  isLabelGroupField(field) || isMovableGroupField(field)
    ? `${key} cannot move there, its team has no matching value.`
    : `${key} stays put, ${GROUP_LABELS[field].toLowerCase()} is not set by dragging.`;

/** Whether the viewer may drag and write one issue. */
export const canDragIssue = (
  env: Pick<IssueViewEnv, 'canEdit' | 'canEditIssue'>,
  issue: OrderedIssueRead
): boolean => env.canEdit && (env.canEditIssue?.(issue) ?? true);

/**
 * Whether a drag may drop into a group of `field` it does not start in: the
 * property is one a drag can set, and a customer group only where the view
 * can file requests.
 */
export const takesDrop = (
  field: GroupField,
  env: Pick<IssueViewEnv, 'moveCustomer'>
): boolean =>
  field === 'customer'
    ? env.moveCustomer !== undefined
    : isMovableGroupField(field);

/** Writes a drop of dragged issues, or explains in a notice why it did not. */
export const landIssueDrop = ({
  env,
  onStateChange,
  movers,
  lead,
  source,
  cellOf,
  to,
  columnField,
  laneField,
  cellIssues,
  columnLabel,
  laneLabel,
}: IssueDrop): void => {
  const { state, context } = env;
  if (!env.canEdit || movers.length === 0) return;
  const alone = movers.length === 1;
  const fromOf = (issue: OrderedIssueRead): DropCell =>
    issue.id === lead ? source : (cellOf(issue.id) ?? source);

  const allowed = movers.filter((issue) => canDragIssue(env, issue));
  const locked = movers.length - allowed.length;
  const changes = new Map<string, IssueChange>();
  const customerMoves: { issue: OrderedIssueRead; move: CustomerMove }[] = [];
  let unmatched = 0;
  let refusal = '';
  let columnMoved = false;
  let laneMoved = false;
  for (const issue of allowed) {
    const from = fromOf(issue);
    const lane = to.lane ?? from.lane;
    let change: IssueChange = {};
    let refused = false;
    if (to.column !== from.column) {
      const moved = moveChange(
        issue,
        columnField,
        from.column,
        to.column,
        context
      );
      if (moved === null) {
        refused = true;
        refusal = refusedMove(issue.key, columnField);
      } else {
        change = joinChanges(change, moved);
      }
    }
    if (!refused && laneField !== 'none' && lane !== from.lane) {
      const moved = moveChange(issue, laneField, from.lane, lane, context);
      if (moved === null) {
        refused = true;
        refusal = refusedMove(issue.key, laneField);
      } else {
        change = joinChanges(change, moved);
      }
    }
    if (refused) {
      unmatched += 1;
      continue;
    }
    if (to.column !== from.column) columnMoved = true;
    if (laneField !== 'none' && lane !== from.lane) laneMoved = true;
    if (columnField === 'customer' && to.column !== from.column) {
      customerMoves.push({
        issue,
        move: customerMove(issue, from.column, to.column, context),
      });
    }
    if (laneField === 'customer' && lane !== from.lane) {
      customerMoves.push({
        issue,
        move: customerMove(issue, from.lane, lane, context),
      });
    }
    changes.set(issue.id, change);
  }

  if (alone && unmatched === 1) {
    showToast(refusal, 'info');
    return;
  }
  const moving = allowed.filter((issue) => changes.has(issue.id));
  const skipped = skippedNotice({ locked, unmatched });
  if (moving.length === 0) {
    if (skipped !== '') showToast(`Nothing moved. ${skipped}`, 'info');
    return;
  }
  if (customerMoves.length > 0 && env.moveCustomer === undefined) {
    showToast(
      alone
        ? `${issueCount(moving)} stays put, customer requests are not set from here.`
        : `${issueCount(moving)} stay put, customer requests are not set from here.`,
      'info'
    );
    return;
  }

  if (to.lane !== null && to.index !== null) {
    const slotLane = to.lane;
    const sameCell = moving.every((issue) => {
      const from = fromOf(issue);
      return from.column === to.column && from.lane === slotLane;
    });
    if (state.ordering === 'manual' || sameCell) {
      const placements = slotPlacements(
        cellIssues(slotLane, to.column),
        to.index,
        moving.map((issue) => issue.id)
      );
      if (sameCell && placements === null) {
        if (skipped !== '') showToast(skipped, 'info');
        return;
      }
      for (const placement of placements ?? []) {
        const change = changes.get(placement.id);
        if (change !== undefined) change.sort_order = placement.sort_order;
      }
      if (
        placements !== null &&
        (state.ordering !== 'manual' || state.reverse)
      ) {
        onStateChange({ ...state, ordering: 'manual', reverse: false });
      }
    }
  }

  const written = moving.filter(
    (issue) => Object.keys(changes.get(issue.id) ?? {}).length > 0
  );
  if (written.length > 0) {
    const destinations = [
      ...(columnMoved ? [columnLabel(to.column)] : []),
      ...(laneMoved && to.lane !== null ? [laneLabel(to.lane)] : []),
    ];
    const fieldsMoved = columnMoved || laneMoved;
    env.update(
      written.map((issue) => issue.id),
      (issue) => changes.get(issue.id) ?? null,
      fieldsMoved && (!alone || skipped !== '')
        ? {
            message: movedNotice(written, destinations, {
              locked,
              unmatched,
            }),
          }
        : undefined
    );
    if (!fieldsMoved && skipped !== '') showToast(skipped, 'info');
  } else if (skipped !== '') {
    showToast(skipped, 'info');
  }
  for (const { issue, move } of customerMoves) {
    if (move.add !== undefined || move.remove !== undefined) {
      env.moveCustomer?.(issue, move);
    }
  }
};
