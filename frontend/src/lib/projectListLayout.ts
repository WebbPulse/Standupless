/**
 * How the projects list fits its columns beside the name. The list measures
 * its own width with a container query rather than the viewport, so the
 * sidebar and any open pane count against it. The name keeps a real minimum
 * width, and the columns join in priority order as the list widens: the
 * properties people scan most first, the dates and people next, and the
 * record timestamps last.
 */

import type React from 'react';
import { INLINE_PROJECT_COLUMNS, type ProjectColumn } from './projectList';

/** A property the list draws in a column of its own rather than beside the name. */
export type GridColumn = Exclude<
  ProjectColumn,
  'summary' | 'milestones' | 'dependencies' | 'labels'
>;

/** The list widths a column joins at, narrowest first. */
export type ColumnTier = 'base' | 'md' | 'lg' | 'xl' | '2xl';

/** The tiers from narrowest to widest. */
export const COLUMN_TIER_ORDER: ColumnTier[] = [
  'base',
  'md',
  'lg',
  'xl',
  '2xl',
];

/** The list width each tier starts at, in rem, matching the container classes. */
export const COLUMN_TIER_WIDTHS: Record<Exclude<ColumnTier, 'base'>, number> = {
  md: 40,
  lg: 60,
  xl: 72,
  '2xl': 96,
};

/** The narrowest tier each column shows from. */
export const COLUMN_TIERS: Record<GridColumn, ColumnTier> = {
  progress: 'base',
  priority: 'md',
  status: 'md',
  lead: 'md',
  health: 'lg',
  target: 'lg',
  issues: 'lg',
  start: 'xl',
  teams: 'xl',
  members: 'xl',
  id: 'xl',
  created: '2xl',
  updated: '2xl',
  completed: '2xl',
};

/** How wide each list column runs beside the name. */
export const COLUMN_WIDTHS: Record<GridColumn, string> = {
  health: '7rem',
  priority: '2rem',
  status: '8.5rem',
  lead: '2rem',
  members: '4.5rem',
  start: '6rem',
  target: '6rem',
  teams: '6rem',
  issues: '4rem',
  created: '5.5rem',
  updated: '5.5rem',
  completed: '5.5rem',
  progress: '4.5rem',
  id: '5.5rem',
};

/** The name track once any column sits beside it, which never squeezes below 16rem. */
export const NAME_TRACK = 'minmax(16rem,1fr)';

/** The name track on the narrowest lists, where it takes whatever is left. */
export const NARROW_NAME_TRACK = 'minmax(0,1fr)';

/** The class that makes the list a container its rows measure against. */
export const PROJECT_LIST_CONTAINER = '@container';

/** The grid every header and row lines up on, its tracks set by projectGridTracks. */
export const PROJECT_GRID =
  'grid grid-cols-[var(--project-columns-base)] items-center gap-3 @min-[40rem]:grid-cols-[var(--project-columns-md)] @min-[60rem]:grid-cols-[var(--project-columns-lg)] @min-[72rem]:grid-cols-[var(--project-columns-xl)] @min-[96rem]:grid-cols-[var(--project-columns-2xl)]';

/** The class that shows a block cell from its tier up. */
export const TIER_BLOCK: Record<ColumnTier, string> = {
  base: 'block',
  md: 'hidden @min-[40rem]:block',
  lg: 'hidden @min-[60rem]:block',
  xl: 'hidden @min-[72rem]:block',
  '2xl': 'hidden @min-[96rem]:block',
};

/** The class that shows a flex cell from its tier up. */
export const TIER_FLEX: Record<ColumnTier, string> = {
  base: 'flex',
  md: 'hidden @min-[40rem]:flex',
  lg: 'hidden @min-[60rem]:flex',
  xl: 'hidden @min-[72rem]:flex',
  '2xl': 'hidden @min-[96rem]:flex',
};

/** The shown properties that take a grid column, in drawing order. */
export const gridColumns = (shown: readonly ProjectColumn[]): GridColumn[] =>
  shown.filter(
    (column): column is GridColumn => !INLINE_PROJECT_COLUMNS.has(column)
  );

/** Whether a column shows at a tier. */
export const showsAt = (column: GridColumn, tier: ColumnTier): boolean =>
  COLUMN_TIER_ORDER.indexOf(COLUMN_TIERS[column]) <=
  COLUMN_TIER_ORDER.indexOf(tier);

/** The track template at one tier: the name, then each shown column that fits. */
export const tierTracks = (
  shown: readonly ProjectColumn[],
  tier: ColumnTier
): string =>
  [
    tier === 'base' ? NARROW_NAME_TRACK : NAME_TRACK,
    ...gridColumns(shown)
      .filter((column) => showsAt(column, tier))
      .map((column) =>
        tier === 'base' && column === 'progress'
          ? '3.5rem'
          : COLUMN_WIDTHS[column]
      ),
  ].join(' ');

/**
 * The grid tracks for the shown columns at every tier, as the custom
 * properties PROJECT_GRID reads, so a hidden column leaves no gap.
 */
export const projectGridTracks = (
  shown: readonly ProjectColumn[]
): React.CSSProperties =>
  Object.fromEntries(
    COLUMN_TIER_ORDER.map((tier) => [
      `--project-columns-${tier}`,
      tierTracks(shown, tier),
    ])
  );
