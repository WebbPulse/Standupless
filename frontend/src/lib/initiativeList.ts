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
import { personLabel, type Assignable } from './issuePeople';
import { progressPercent } from './planningDisplay';
import { PROJECT_HEALTHS, PROJECT_HEALTH_LABELS } from './projectLook';
import { byManual, datePeriod, type DatePeriod } from './projectList';

/** The initiatives list arrangement, every field filled. */
export type InitiativesDisplay = InitiativesDisplayPreference;

/** What the list groups rows by. */
export type InitiativeGrouping = InitiativesDisplay['grouping'];

/** The groupings, in the order the Display menu offers them. */
export const INITIATIVE_GROUPINGS: InitiativeGrouping[] = [
  'status',
  'team',
  'owner',
  'health',
  'target_date',
];

/** How each grouping reads. */
export const INITIATIVE_GROUPING_LABELS: Record<InitiativeGrouping, string> = {
  status: 'Status',
  team: 'Team',
  owner: 'Owner',
  health: 'Health',
  target_date: 'Target date',
};

/** How rows run inside each group. */
export type InitiativeOrdering = InitiativesDisplay['order'];

/** Whether the completed group shows. */
export type CompletedChoice = InitiativesDisplay['completed'];

/** A property the list can show beside the name. */
export type InitiativeColumn =
  'health' | 'team' | 'owner' | 'projects' | 'start' | 'target' | 'progress';

/** Every property, in the order the row draws them. */
export const INITIATIVE_COLUMNS: InitiativeColumn[] = [
  'health',
  'team',
  'owner',
  'projects',
  'start',
  'target',
  'progress',
];

/** How each property reads in the Display menu and the header. */
export const INITIATIVE_COLUMN_LABELS: Record<InitiativeColumn, string> = {
  health: 'Health',
  team: 'Team',
  owner: 'Owner',
  projects: 'Projects',
  start: 'Start date',
  target: 'Target date',
  progress: 'Progress',
};

/** Whether the page draws the list or the timeline. */
export type InitiativeLayout = InitiativesDisplay['layout'];

/** The layouts, in the order the Display menu offers them. */
export const INITIATIVE_LAYOUTS: InitiativeLayout[] = ['list', 'timeline'];

/** The timeline scales, the same ones the projects timeline offers. */
export const INITIATIVE_ZOOMS: InitiativesDisplay['zoom'][] = [
  'week',
  'month',
  'quarter',
  'year',
];

/** The orderings, in the order the Display menu offers them. */
export const INITIATIVE_ORDERINGS: InitiativeOrdering[] = [
  'manual',
  'target',
  'name',
  'progress',
  'created',
  'updated',
];

/** How each ordering reads. */
export const INITIATIVE_ORDERING_LABELS: Record<InitiativeOrdering, string> = {
  manual: 'Manual',
  target: 'Target date',
  name: 'Name',
  progress: 'Progress',
  created: 'Created',
  updated: 'Last updated',
};

/** The arrangement a list that was never arranged opens with. */
export const DEFAULT_INITIATIVES_DISPLAY: InitiativesDisplay = {
  layout: 'list',
  zoom: 'month',
  grouping: 'status',
  order: 'target',
  completed: 'show',
  columns: INITIATIVE_COLUMNS.join(','),
};

/** The arrangement fields, each one URL parameter. */
export const INITIATIVES_DISPLAY_FIELDS: (keyof InitiativesDisplay)[] = [
  'layout',
  'zoom',
  'grouping',
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
    field === 'order'
      ? INITIATIVE_ORDERINGS
      : field === 'grouping'
        ? INITIATIVE_GROUPINGS
        : field === 'layout'
          ? INITIATIVE_LAYOUTS
          : field === 'zoom'
            ? INITIATIVE_ZOOMS
            : ['show', 'hide'];
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
    layout: pick('layout'),
    zoom: pick('zoom'),
    grouping: pick('grouping'),
    order: pick('order'),
    completed: pick('completed'),
    columns: pick('columns'),
  };
};

/** The owner filter value for initiatives nobody owns. */
export const NO_OWNER = 'none';

/** The team filter value for workspace level initiatives with no lead team. */
export const NO_TEAM = 'none';

/** The health filter value for initiatives with no health set. */
export const NO_HEALTH = 'none';

/** What the filter chips hold. Empty means the filter is off. */
export interface InitiativeFilters {
  status: InitiativeStatus[];
  owner: string;
  health: string[];
  /** A lead team id, `NO_TEAM`, or empty for every team. */
  team?: string;
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
    filters.health.includes(initiative.health ?? NO_HEALTH)) &&
  (filters.team === undefined ||
    filters.team === '' ||
    (initiative.team_id ?? NO_TEAM) === filters.team);

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
    case 'manual':
      return byManual(left, right) || byName;
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

/** One group the owner, health or target date grouping files initiatives under. */
export interface InitiativeValueGroup {
  /** Stable across reads, such as `owner:<id>`, `health:at_risk` or `target_date:2026-11`. */
  key: string;
  label: string;
  /** The owner id, the health, or the period; `none` for the empty group. */
  value: string;
  rows: InitiativeRead[];
}

/** The group key initiatives nobody owns sit under. */
export const NO_OWNER_GROUP_KEY = `owner:${NO_OWNER}`;

/** The group key initiatives with no health sit under. */
export const NO_HEALTH_GROUP_KEY = `health:${NO_HEALTH}`;

/** The group key initiatives with no target date sit under. */
export const NO_TARGET_GROUP_KEY = 'target_date:none';

/**
 * Groups already ordered initiatives by owner, owners by name and "No owner"
 * last. An owner who has left the workspace reads as an unknown owner.
 */
export const ownerGroups = (
  ordered: readonly InitiativeRead[],
  people: readonly Assignable[]
): InitiativeValueGroup[] => {
  const held = new Map<string, InitiativeRead[]>();
  const unowned: InitiativeRead[] = [];
  for (const initiative of ordered) {
    if (initiative.owner_id === null) {
      unowned.push(initiative);
      continue;
    }
    held.set(initiative.owner_id, [
      ...(held.get(initiative.owner_id) ?? []),
      initiative,
    ]);
  }
  const labelOf = (id: string): string => {
    const person = people.find((item) => item.user_id === id);
    return person === undefined ? 'Unknown owner' : personLabel(person);
  };
  const owned = [...held.entries()]
    .map(([id, rows]) => ({
      key: `owner:${id}`,
      label: labelOf(id),
      value: id,
      rows,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return unowned.length === 0
    ? owned
    : [
        ...owned,
        {
          key: NO_OWNER_GROUP_KEY,
          label: 'No owner',
          value: NO_OWNER,
          rows: unowned,
        },
      ];
};

/** Groups already ordered initiatives by health, on track first and "No health" last. */
export const healthGroups = (
  ordered: readonly InitiativeRead[]
): InitiativeValueGroup[] =>
  [
    ...PROJECT_HEALTHS.map((health) => ({
      key: `health:${health}`,
      label: PROJECT_HEALTH_LABELS[health],
      value: health,
      rows: ordered.filter((initiative) => initiative.health === health),
    })),
    {
      key: NO_HEALTH_GROUP_KEY,
      label: 'No health',
      value: NO_HEALTH,
      rows: ordered.filter(
        (initiative) =>
          initiative.health === null ||
          !PROJECT_HEALTHS.includes(initiative.health)
      ),
    },
  ].filter((group) => group.rows.length > 0);

/**
 * Groups already ordered initiatives by the period of their target date, the
 * way the projects list does: an exact day or a month under its calendar
 * month, a quarter, half or year under its own period after the months it
 * covers, earliest first, and "No target date" last.
 */
export const targetDateGroups = (
  ordered: readonly InitiativeRead[]
): InitiativeValueGroup[] => {
  const held = new Map<
    string,
    { period: DatePeriod; rows: InitiativeRead[] }
  >();
  const undated: InitiativeRead[] = [];
  for (const initiative of ordered) {
    const period = datePeriod(
      initiative.target_date,
      initiative.target_date_resolution
    );
    if (period === null) {
      undated.push(initiative);
      continue;
    }
    const entry = held.get(period.value) ?? { period, rows: [] };
    entry.rows.push(initiative);
    held.set(period.value, entry);
  }
  const dated = [...held.values()]
    .sort((left, right) => left.period.rank.localeCompare(right.period.rank))
    .map(({ period, rows }) => ({
      key: `target_date:${period.value}`,
      label: period.label,
      value: period.value,
      rows,
    }));
  return undated.length === 0
    ? dated
    : [
        ...dated,
        {
          key: NO_TARGET_GROUP_KEY,
          label: 'No target date',
          value: 'none',
          rows: undated,
        },
      ];
};
