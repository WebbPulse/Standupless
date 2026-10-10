/**
 * A saved view's icon in its color. The icon is stored by name and the color
 * from a fixed palette, so every surface that lists views, the index, the
 * sidebar and the palette, draws the same mark without storing markup.
 */

import React from 'react';
import type { IconType } from 'react-icons';
import {
  LuBug,
  LuCircleDot,
  LuClock,
  LuFlag,
  LuFlame,
  LuInbox,
  LuLayers,
  LuList,
  LuRocket,
  LuSquareKanban,
  LuStar,
  LuTarget,
  LuUserRound,
  LuZap,
} from 'react-icons/lu';
import type { ViewColor } from '../../api/views';
import { cn } from '../../lib/cn';

/** The icons a view can take, by the name stored on it. */
export const VIEW_ICONS: Record<string, IconType> = {
  layers: LuLayers,
  list: LuList,
  board: LuSquareKanban,
  bug: LuBug,
  flag: LuFlag,
  flame: LuFlame,
  target: LuTarget,
  zap: LuZap,
  rocket: LuRocket,
  star: LuStar,
  inbox: LuInbox,
  clock: LuClock,
  person: LuUserRound,
  issue: LuCircleDot,
};

/** The icon names in picker order. */
export const VIEW_ICON_NAMES = Object.keys(VIEW_ICONS);

/** The swatch each palette color draws with, readable on light and dark. */
export const VIEW_COLOR_HEX: Record<ViewColor, string> = {
  gray: '#8a8f98',
  red: '#eb5757',
  orange: '#f2994a',
  yellow: '#e2b93b',
  green: '#4cb782',
  teal: '#26b5ce',
  blue: '#4ea7fc',
  indigo: '#5e6ad2',
  purple: '#9b6bd8',
  pink: '#e86fb0',
};

/** Props for ViewIcon. */
export interface ViewIconProps {
  icon?: string | null | undefined;
  color?: ViewColor | null | undefined;
  /** The layout a view without its own icon falls back to. */
  layout?: string | null | undefined;
  className?: string;
}

/** A view's mark: its own icon and color, or a layout glyph in the faint text color. */
export const ViewIcon: React.FC<ViewIconProps> = ({
  icon,
  color,
  layout,
  className,
}) => {
  const Icon =
    (icon ? VIEW_ICONS[icon] : undefined) ??
    (layout === 'board' ? LuSquareKanban : LuLayers);
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'shrink-0',
        !color && 'text-text-faint',
        className ?? 'h-4 w-4'
      )}
      style={color ? { color: VIEW_COLOR_HEX[color] } : undefined}
    />
  );
};

export default ViewIcon;
