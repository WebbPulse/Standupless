/**
 * How the initiatives list filters, orders and arranges its rows. Kept apart
 * from the page so the URL reading, the defaults and the ordering are plain
 * functions the page, its Display menu and the tests share.
 */

import type {
  InitiativeRead,
  InitiativeStatus,
  InitiativesDisplayPreference,
  ProjectHealth,
} from '../types/Api';
import { progressPercent } from './planningDisplay';

/** The initiatives list arrangement, every field filled. */
export type InitiativesDisplay = InitiativesDisplayPreference;

/** How rows run inside each status group. */
export type InitiativeOrdering = InitiativesDisplay['order'];

/** Whether the completed group shows. */
export type CompletedChoice = InitiativesDisplay['completed'];

/** A property the list can show beside the name. */
export type InitiativeColumn =
  'health' | 'owner' | 'projects' | 'target' | 'progress';

/** Every property, in the order the row draws them. */
export const INITIATIVE_COLUMNS: InitiativeColumn[] = [
  'health',
  'owner',
  'projects',
  'target',
  'progress',
];

/** How each property reads in the Display menu and the header. */
export const INITIATIVE_COLUMN_LABELS: Record<InitiativeColumn, string> = {
  health: 'Health',
  owner: 'Owner',
  projects: 'Projects',
  target: 'Target date',
  progress: 'Progress',
};

/** The orderings, in the order the Display menu offers them. */
export const INITIATIVE_ORDERINGS: InitiativeOrdering[] = [
  'target',
  'name',
  'progress',
  'created',
  'updated',
];

/** How each ordering reads. */
export const INITIATIVE_ORDERING_LABELS: Record<InitiativeOrdering, string> = {
  target: 'Target date',
  name: 'Name',
  progress: 'Progress',
  created: 'Created',
  updated: 'Last updated',
};

/** The arrangement a list that was never arranged opens with. */
export const DEFAULT_INITIATIVES_DISPLAY: InitiativesDisplay = {
  order: 'target',
  completed: 'show',
  columns: INITIATIVE_COLUMNS.join(','),
};

/** The arrangement fields, each one URL parameter. */
export const INITIATIVES_DISPLAY_FIELDS: (keyof InitiativesDisplay)[] = [
  'order',
  'completed',
  'columns',
];

/** The shown properties a stored or URL value names, in drawing order. */
export const initiativeColumnList = (value: string): InitiativeColumn[] => {
  const named = value.split(',').map((token) => token.trim());
  return INITIATIVE_COLUMNS.filter((column) => named.includes(column));
};

/** A column choice written the one way the account and the URL store it. */
export const initiativeColumnValue = (
  columns: readonly InitiativeColumn[]
): string =>
  INITIATIVE_COLUMNS.filter((column) => columns.includes(column)).join(',');

/** One field from a URL or stored value, or undefined when it is not a known choice. */
const parseField = <K extends keyof InitiativesDisplay>(
  field: K,
  value: string | null | undefined
): InitiativesDisplay[K] | undefined => {
  if (value === null || value === undefined) return undefined;
  if (field === 'columns')
    return initiativeColumnValue(
      initiativeColumnList(value)
    ) as InitiativesDisplay[K];
  const choices: readonly string[] =
    field === 'order' ? INITIATIVE_ORDERINGS : ['show', 'hide'];
  return choices.includes(value) ? (value as InitiativesDisplay[K]) : undefined;
};

/** The arrangement in force: each field from the URL, else what was saved, else the default. */
export const resolveInitiativesDisplay = (
  read: (field: keyof InitiativesDisplay) => string | null,
  saved: Partial<InitiativesDisplay> | undefined
): InitiativesDisplay => {
  const pick = <K extends keyof InitiativesDisplay>(
    field: K
  ): InitiativesDisplay[K] =>
    parseField(field, read(field)) ??
    parseField(field, saved?.[field]) ??
    DEFAULT_INITIATIVES_DISPLAY[field];
  return {
    order: pick('order'),
    completed: pick('completed'),
    columns: pick('columns'),
  };
};

/** The owner filter value for initiatives nobody owns. */
export const NO_OWNER = 'none';

/** The health filter value for initiatives with no health set. */
export const NO_HEALTH = 'none';

/** What the filter chips hold. Empty means the filter is off. */
export interface InitiativeFilters {
  status: InitiativeStatus[];
  owner: string;
  health: string[];
}

/** Whether an initiative passes every filter. */
export const matchesInitiativeFilters = (
  initiative: InitiativeRead,
  filters: InitiativeFilters
): boolean =>
  (filters.status.length === 0 || filters.status.includes(initiative.status)) &&
  (filters.owner === '' ||
    (filters.owner === NO_OWNER
      ? initiative.owner_id === null
      : initiative.owner_id === filters.owner)) &&
  (filters.health.length === 0 ||
    filters.health.includes(initiative.health ?? NO_HEALTH));

/** Whether a known health value or the no health value. */
export const isHealthFilterValue = (
  value: string
): value is ProjectHealth | typeof NO_HEALTH =>
  value === NO_HEALTH ||
  value === 'on_track' ||
  value === 'at_risk' ||
  value === 'off_track';

/** Compares two initiatives under an ordering, the name breaking ties. */
const compareBy = (
  ordering: InitiativeOrdering,
  left: InitiativeRead,
  right: InitiativeRead
): number => {
  const byName = left.name.localeCompare(right.name);
  switch (ordering) {
    case 'name':
      return byName;
    case 'progress':
      return progressPercent(right) - progressPercent(left) || byName;
    case 'created':
      return right.created_at.localeCompare(left.created_at) || byName;
    case 'updated':
      return right.updated_at.localeCompare(left.updated_at) || byName;
    case 'target':
      return (
        (left.target_date ?? '9999').localeCompare(
          right.target_date ?? '9999'
        ) || byName
      );
  }
};

/**
 * The initiatives sorted under an ordering. The tree is drawn from this order,
 * so siblings run in it under their parent and a parent stays above its children.
 */
export const orderInitiatives = (
  initiatives: readonly InitiativeRead[],
  ordering: InitiativeOrdering
): InitiativeRead[] =>
  [...initiatives].sort((left, right) => compareBy(ordering, left, right));
