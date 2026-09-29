/**
 * The rules the workflow settings pages share: the status categories in
 * board order, whether a row is inherited from the workspace or overridden by
 * the team, how rows group by category, and which neighbour a row swaps with
 * when it moves.
 */

import type {
  LabelRead,
  StatusCategory,
  StatusRead,
  WorkflowScope,
} from '../types/Api';

/** The categories in board order, with the wording the settings pages use. */
export const STATUS_CATEGORIES: readonly {
  value: StatusCategory;
  label: string;
}[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'unstarted', label: 'Unstarted' },
  { value: 'started', label: 'Started' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** How a category reads in a heading or beside a status. */
export const categoryLabel = (category: StatusCategory): string =>
  STATUS_CATEGORIES.find((item) => item.value === category)?.label ?? category;

/** A status or label row, as far as scope and overrides go. */
export interface WorkflowRow {
  id: string;
  name: string;
  scope?: WorkflowScope;
  hidden?: boolean;
  inherited_name?: string | null;
}

/** Whether a row comes from the workspace rather than the team. */
export const isInherited = (row: WorkflowRow): boolean =>
  row.scope === 'workspace';

/** Whether the team hid or renamed an inherited row, so a reset would change it. */
export const isOverridden = (row: WorkflowRow): boolean =>
  isInherited(row) &&
  (row.hidden === true ||
    (row.inherited_name !== undefined && row.inherited_name !== null));

/** The name the workspace gave an inherited row, before any local rename. */
export const workspaceName = (row: WorkflowRow): string =>
  row.inherited_name ?? row.name;

/** The rows a picker offers: everything the team has not hidden. */
export const visibleRows = <T extends WorkflowRow>(rows: readonly T[]): T[] =>
  rows.filter((row) => row.hidden !== true);

/** One category and its statuses in position order. */
export interface CategoryGroup {
  category: StatusCategory;
  label: string;
  statuses: StatusRead[];
}

/** Splits statuses into every category in board order, each sorted by position. */
export const groupByCategory = (
  statuses: readonly StatusRead[]
): CategoryGroup[] =>
  STATUS_CATEGORIES.map(({ value, label }) => ({
    category: value,
    label,
    statuses: statuses
      .filter((status) => status.category === value)
      .sort((left, right) => left.position - right.position),
  }));

/**
 * The status a row swaps positions with when it moves up or down: the nearest
 * one in its category that the caller may also edit, or undefined at the end.
 */
export const swapNeighbour = (
  group: readonly StatusRead[],
  status: StatusRead,
  direction: -1 | 1,
  movable: (row: StatusRead) => boolean = () => true
): StatusRead | undefined => {
  const candidates = group.filter(movable);
  const index = candidates.findIndex((row) => row.id === status.id);
  if (index < 0) return undefined;
  return candidates[index + direction];
};

/** The position one past the last status, for a new one added at the end. */
export const nextPosition = (statuses: readonly StatusRead[]): number =>
  statuses.length === 0
    ? 0
    : Math.max(...statuses.map((status) => status.position)) + 1;

/** Labels in name order, as both settings pages list them. */
export const sortLabels = (labels: readonly LabelRead[]): LabelRead[] =>
  [...labels].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  );

/** Drops a repeated row, keeping the first, as a list merged from several teams repeats workspace rows. */
export const uniqueById = <T extends { id: string }>(
  rows: readonly T[]
): T[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
};
