/**
 * How a project looks and how it is tracking: the glyphs a project icon can
 * wear, the colours it can be tinted, and the health values with their
 * labels. Kept apart from the components so the lists can be tested and so
 * the projects list, the project page and the roadmap draw them the same.
 */

import type { IconType } from 'react-icons';
import {
  LuBookOpen,
  LuBox,
  LuBug,
  LuCode,
  LuFlag,
  LuGlobe,
  LuHeart,
  LuLayers,
  LuRocket,
  LuShield,
  LuSparkles,
  LuStar,
  LuTarget,
  LuUsers,
  LuWrench,
  LuZap,
} from 'react-icons/lu';
import { LABEL_PALETTE } from './propertyOptions';
import type { ProjectHealth, ProjectIconName } from '../types/Api';

/** Each icon name the API accepts and the glyph it draws. */
export const PROJECT_ICON_GLYPHS: Record<ProjectIconName, IconType> = {
  box: LuBox,
  rocket: LuRocket,
  target: LuTarget,
  flag: LuFlag,
  zap: LuZap,
  star: LuStar,
  bug: LuBug,
  book: LuBookOpen,
  code: LuCode,
  globe: LuGlobe,
  heart: LuHeart,
  layers: LuLayers,
  shield: LuShield,
  sparkles: LuSparkles,
  users: LuUsers,
  wrench: LuWrench,
};

/** The icon names in the order the picker lays them out. */
export const PROJECT_ICON_NAMES = Object.keys(
  PROJECT_ICON_GLYPHS
) as ProjectIconName[];

/** The colours a project can be tinted, shared with the label palette. */
export const PROJECT_COLORS: string[] = LABEL_PALETTE;

/** The health values, best first, in the order the picker offers them. */
export const PROJECT_HEALTHS: ProjectHealth[] = [
  'on_track',
  'at_risk',
  'off_track',
];

/** How each health value reads. */
export const PROJECT_HEALTH_LABELS: Record<ProjectHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};

/** How a health value reads, including a project nobody has judged yet. */
export const healthLabel = (
  health: ProjectHealth | null | undefined
): string =>
  health === null || health === undefined
    ? 'No updates'
    : PROJECT_HEALTH_LABELS[health];

/** The glyph a project draws, the plain box when it has picked none. */
export const projectGlyph = (
  icon: ProjectIconName | null | undefined
): IconType =>
  icon === null || icon === undefined ? LuBox : PROJECT_ICON_GLYPHS[icon];
