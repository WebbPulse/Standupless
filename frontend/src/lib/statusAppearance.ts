/**
 * How a workflow status looks: the curated color palette, the icon variants
 * each category allows, and the resolver that turns a stored status into the
 * icon, color and fill a glyph draws.
 *
 * It mirrors `backend/app/common/status_appearance.py`. Both fields are plain
 * and optional on the status row, and a missing one falls back to the
 * category, so a row written before they existed renders as it always did.
 */

import type { StatusCategory } from '../types/Api';

/** Every palette color a status may carry, in the order the picker shows them. */
export const STATUS_COLORS = [
  'gray',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'purple',
  'pink',
] as const;

/** One palette color name, as the API stores it. */
export type StatusColor = (typeof STATUS_COLORS)[number];

/**
 * The tone each palette color draws in. They are mid tones picked to hold
 * contrast on both the light and the dark surfaces, so one value serves both
 * themes rather than a pair drifting apart.
 */
export const STATUS_COLOR_VALUES: Record<StatusColor, string> = {
  gray: '#8b919c',
  red: '#e5484d',
  orange: '#f0712c',
  amber: '#e59a12',
  yellow: '#c9a90a',
  lime: '#76a91c',
  green: '#2f9e62',
  teal: '#12a594',
  cyan: '#0797b9',
  blue: '#3b7cf0',
  indigo: '#5e6ad2',
  violet: '#8b5cd6',
  purple: '#b04fc0',
  pink: '#d6409f',
};

/** Every icon variant a status may carry, across all categories. */
export const STATUS_ICONS = [
  'dashed',
  'dotted',
  'question',
  'circle',
  'circle_dot',
  'progress',
  'quarter',
  'half',
  'three_quarters',
  'paused',
  'blocked',
  'check',
  'check_outline',
  'cross',
  'cross_outline',
  'duplicate',
] as const;

/** One icon variant name, as the API stores it. */
export type StatusIconName = (typeof STATUS_ICONS)[number];

/**
 * The icon variants each category allows, its default first. A check on a
 * started status would say something false about where the issue is, so the
 * choice is scoped to the category.
 */
export const ICONS_BY_CATEGORY: Record<
  StatusCategory,
  readonly StatusIconName[]
> = {
  backlog: ['dashed', 'dotted', 'question'],
  unstarted: ['circle', 'circle_dot'],
  started: [
    'progress',
    'quarter',
    'half',
    'three_quarters',
    'paused',
    'blocked',
  ],
  completed: ['check', 'check_outline'],
  cancelled: ['cross', 'cross_outline', 'duplicate'],
};

/** The name each icon variant is announced and listed by. */
export const STATUS_ICON_LABELS: Record<StatusIconName, string> = {
  dashed: 'Dashed circle',
  dotted: 'Dotted circle',
  question: 'Question',
  circle: 'Empty circle',
  circle_dot: 'Circle with dot',
  progress: 'Progress by position',
  quarter: 'Quarter',
  half: 'Half',
  three_quarters: 'Three quarters',
  paused: 'Paused',
  blocked: 'Blocked',
  check: 'Check',
  check_outline: 'Outlined check',
  cross: 'Cross',
  cross_outline: 'Outlined cross',
  duplicate: 'Duplicate',
};

/** The name each palette color is announced and listed by. */
export const STATUS_COLOR_LABELS: Record<StatusColor, string> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  yellow: 'Yellow',
  lime: 'Lime',
  green: 'Green',
  teal: 'Teal',
  cyan: 'Cyan',
  blue: 'Blue',
  indigo: 'Indigo',
  violet: 'Violet',
  purple: 'Purple',
  pink: 'Pink',
};

/** The theme token each category draws in when its status has no color. */
export const CATEGORY_DEFAULT_COLOR: Record<StatusCategory, string> = {
  backlog: 'var(--text-faint)',
  unstarted: 'var(--text-muted)',
  started: 'var(--warning)',
  completed: 'var(--success)',
  cancelled: 'var(--text-faint)',
};

const FIXED_FILL: Partial<Record<StatusIconName, number>> = {
  quarter: 0.25,
  half: 0.5,
  three_quarters: 0.75,
};

/** The fields a status glyph reads, which every status shape the app holds has. */
export interface StatusLike {
  id?: string;
  team_id?: string;
  category: StatusCategory;
  position?: number;
  color?: string | null;
  icon?: string | null;
}

/** What a status glyph draws: the variant, a CSS color and a pie fill from 0 to 1. */
export interface StatusLook {
  icon: StatusIconName;
  color: string;
  fill: number;
}

/** Whether a stored value is a palette color this build knows. */
export const isStatusColor = (value: unknown): value is StatusColor =>
  typeof value === 'string' &&
  (STATUS_COLORS as readonly string[]).includes(value);

/** Whether a string from an untyped response is a status category. */
export const isStatusCategory = (value: string): value is StatusCategory =>
  Object.hasOwn(ICONS_BY_CATEGORY, value);

/** Whether a stored icon may sit on a status of this category. */
export const iconFits = (
  category: StatusCategory,
  icon: unknown
): icon is StatusIconName =>
  typeof icon === 'string' &&
  (ICONS_BY_CATEGORY[category] as readonly string[]).includes(icon);

/** The icon a category draws when its status names none. */
export const defaultIcon = (category: StatusCategory): StatusIconName =>
  ICONS_BY_CATEGORY[category][0] ?? 'dashed';

/**
 * The fill a `progress` icon draws: the status's rank among its team's started
 * statuses, so In Progress, In Review and On Staging read as rising progress
 * with no setup. One started status is half full, as it always was, and a
 * status whose siblings are unknown falls back to half.
 */
export const progressFill = (
  status: StatusLike,
  statuses: readonly StatusLike[] = []
): number => {
  const started = statuses
    .filter(
      (row) =>
        row.category === 'started' &&
        (status.team_id === undefined ||
          row.team_id === undefined ||
          row.team_id === status.team_id)
    )
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  const rank = started.findIndex((row) =>
    status.id === undefined ? row === status : row.id === status.id
  );
  if (rank < 0) return 0.5;
  return (rank + 1) / (started.length + 1);
};

/**
 * Resolves a status to what its glyph draws. A color or icon the build does not
 * know, or an icon from another category, falls back to the category default
 * rather than drawing something misleading.
 */
export const statusLook = (
  status: StatusLike,
  statuses?: readonly StatusLike[]
): StatusLook => {
  const icon = iconFits(status.category, status.icon)
    ? status.icon
    : defaultIcon(status.category);
  const color = isStatusColor(status.color)
    ? STATUS_COLOR_VALUES[status.color]
    : CATEGORY_DEFAULT_COLOR[status.category];
  const fill =
    icon === 'progress'
      ? progressFill(status, statuses)
      : (FIXED_FILL[icon] ?? 0);
  return { icon, color, fill };
};

/** What a glyph draws for an issue whose status is unknown or still loading. */
export const UNKNOWN_STATUS_LOOK: StatusLook = {
  icon: 'dashed',
  color: 'var(--text-faint)',
  fill: 0,
};

/** The radius of the pie a progress glyph fills inside its ring. */
export const PIE_RADIUS = 3.5;

/** The wedge that fills a pie from twelve o'clock, clockwise, by a fraction. */
export const piePath = (fraction: number): string => {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const angle = clamped * 2 * Math.PI;
  const x = 7 + PIE_RADIUS * Math.sin(angle);
  const y = 7 - PIE_RADIUS * Math.cos(angle);
  const large = clamped > 0.5 ? 1 : 0;
  return `M7 7 L7 ${String(7 - PIE_RADIUS)} A${String(PIE_RADIUS)} ${String(PIE_RADIUS)} 0 ${String(large)} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
};
