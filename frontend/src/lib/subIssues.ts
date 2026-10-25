/**
 * How the sub-issues section of an issue arranges its rows: the ordering, and
 * whether completed sub-issues show, remembered in this browser for the person
 * viewing so every issue opens the section the way they left it. Also the
 * manual positions a dragged sub-issue is written with.
 */

import { orderBetween, type OrderedIssueRead } from '../api/issues';
import type { StatusRead } from '../types/Api';
import { sortIssues, type IssueContext } from './issueView';

/** The orderings the sub-issues section offers. */
export type SubIssueOrdering =
  'manual' | 'priority_desc' | 'status_asc' | 'updated_desc';

/** The orderings in menu order. */
export const SUB_ISSUE_ORDERINGS: readonly SubIssueOrdering[] = [
  'manual',
  'priority_desc',
  'status_asc',
  'updated_desc',
];

/** How each ordering reads in the menu. */
export const SUB_ISSUE_ORDERING_LABELS: Record<SubIssueOrdering, string> = {
  manual: 'Manual',
  priority_desc: 'Priority',
  status_asc: 'Status',
  updated_desc: 'Last updated',
};

/** The section's arrangement. */
export interface SubIssueDisplay {
  ordering: SubIssueOrdering;
  showCompleted: boolean;
}

/** The arrangement before the person changes anything. */
export const DEFAULT_SUB_ISSUE_DISPLAY: SubIssueDisplay = {
  ordering: 'manual',
  showCompleted: true,
};

/** The local storage key the arrangement is kept under. */
export const SUB_ISSUE_DISPLAY_KEY = 'standupless-sub-issues-display';

/** The categories that count as completed for hiding. */
const DONE_CATEGORIES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
]);

/**
 * The stored arrangement, or the default for anything missing, unreadable or
 * written by another version, and when storage refuses.
 */
export const readSubIssueDisplay = (): SubIssueDisplay => {
  try {
    const raw = globalThis.localStorage.getItem(SUB_ISSUE_DISPLAY_KEY);
    if (raw === null) return DEFAULT_SUB_ISSUE_DISPLAY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_SUB_ISSUE_DISPLAY;
    }
    const held = parsed as Record<string, unknown>;
    const ordering = SUB_ISSUE_ORDERINGS.find(
      (choice) => choice === held['ordering']
    );
    return {
      ordering: ordering ?? DEFAULT_SUB_ISSUE_DISPLAY.ordering,
      showCompleted:
        typeof held['showCompleted'] === 'boolean'
          ? held['showCompleted']
          : DEFAULT_SUB_ISSUE_DISPLAY.showCompleted,
    };
  } catch {
    return DEFAULT_SUB_ISSUE_DISPLAY;
  }
};

/** Keeps the arrangement, ignoring a storage that refuses. */
export const writeSubIssueDisplay = (display: SubIssueDisplay): void => {
  try {
    globalThis.localStorage.setItem(
      SUB_ISSUE_DISPLAY_KEY,
      JSON.stringify(display)
    );
  } catch {
    return;
  }
};

/** Whether a row sits in a completed or cancelled status. */
export const isDoneRow = (
  row: OrderedIssueRead,
  statuses: readonly StatusRead[]
): boolean => {
  const status = statuses.find((entry) => entry.id === row.status_id);
  return status !== undefined && DONE_CATEGORIES.has(status.category);
};

/** The rows in an ordering, ranking statuses by the team's own. */
export const sortSubIssues = (
  rows: OrderedIssueRead[],
  ordering: SubIssueOrdering,
  statuses: StatusRead[]
): OrderedIssueRead[] => {
  const context: IssueContext = {
    statuses,
    labels: [],
    people: [],
    projects: [],
    cycles: [],
  };
  return sortIssues(rows, ordering, { context });
};

/** One sub-issue's new manual position. */
export interface SubIssuePlacement {
  id: string;
  sort_order: string;
}

/**
 * The manual positions that drop a sub-issue at `index` among the other rows,
 * given in the order they are shown. It lands just after the row shown above
 * the drop point, or first when there is none, so the drop reads right once
 * the rows run in manual order. One key is written when every row ahead of it
 * is placed; otherwise the unplaced rows up to it are placed too, in manual
 * order, since unplaced rows sort last. Empty when nothing moves, null when no
 * key fits.
 */
export const subIssueDropKeys = (
  rows: readonly OrderedIssueRead[],
  movingId: string,
  index: number
): SubIssuePlacement[] | null => {
  const shown = rows.filter((row) => row.id !== movingId);
  const moving = rows.find((row) => row.id === movingId);
  if (moving === undefined) return null;
  const above =
    index > 0 ? shown[Math.min(index, shown.length) - 1] : undefined;
  const manual = sortIssues(shown, 'manual');
  const at = above === undefined ? 0 : manual.indexOf(above) + 1;
  const moved = [...manual.slice(0, at), moving, ...manual.slice(at)];
  const keyOf = (row: OrderedIssueRead | undefined): string | null =>
    row?.sort_order ?? null;
  try {
    const firstLoose = moved
      .slice(0, at)
      .findIndex((row) => keyOf(row) === null);
    if (firstLoose < 0) {
      const before = keyOf(moved[at - 1]);
      const after = keyOf(moved[at + 1]);
      const current = keyOf(moving);
      if (
        current !== null &&
        (before === null || before < current) &&
        (after === null || current < after)
      ) {
        return [];
      }
      return [{ id: movingId, sort_order: orderBetween(before, after) }];
    }
    let bound = keyOf(moved[firstLoose - 1]);
    const placements: SubIssuePlacement[] = [];
    for (const row of moved.slice(firstLoose, at + 1)) {
      bound = orderBetween(bound, undefined);
      placements.push({ id: row.id, sort_order: bound });
    }
    return placements;
  } catch {
    return null;
  }
};

/**
 * The sub-issue shown first under the person's display settings: the first
 * row in the chosen ordering, skipping completed rows while they are hidden,
 * or the first row of all when every one is completed. Undefined for none.
 */
export const firstSubIssue = (
  rows: readonly OrderedIssueRead[],
  statuses: StatusRead[],
  display: SubIssueDisplay = readSubIssueDisplay()
): OrderedIssueRead | undefined => {
  const ordered = sortSubIssues([...rows], display.ordering, statuses);
  const shown = display.showCompleted
    ? ordered
    : ordered.filter((row) => !isDoneRow(row, statuses));
  return shown[0] ?? ordered[0];
};
