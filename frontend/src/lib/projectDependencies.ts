/**
 * Where the timeline draws its dependency lines. Each line leaves the end of
 * the blocking project's bar and lands on the start of the bar it holds up,
 * in lane pixels, so the overlay can sit on the lanes without measuring the
 * page. A line is late when the waiting project is planned to start before
 * its blocker is planned to end, which is the overlap a planner wants to see.
 */

import type { ProjectGroup } from './projectList';
import { barDays, type BarDays, type TimelineRange } from './timeline';

/** How tall one project lane is, in pixels. */
export const LANE_HEIGHT = 40;

/** How tall a group header above its lanes is, in pixels. */
export const GROUP_HEADER_HEIGHT = 32;

/** One dependency line on the timeline, in lane pixels. */
export interface DependencyLine {
  key: string;
  blockerId: string;
  blockedId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  late: boolean;
}

/** Where one drawn lane sits: its vertical centre and its bar's days. */
interface Lane {
  centre: number;
  bar: BarDays;
}

/**
 * The vertical centre and bar of every dated project in view, walking the
 * groups the way the timeline stacks them. A folded group keeps its header
 * and hides its lanes.
 */
const placeLanes = (
  groups: ProjectGroup[],
  folded: readonly string[]
): Map<string, Lane> => {
  const lanes = new Map<string, Lane>();
  let top = 0;
  for (const group of groups) {
    if (group.kind !== 'none') top += GROUP_HEADER_HEIGHT;
    if (group.kind !== 'none' && folded.includes(group.key)) continue;
    for (const project of group.rows) {
      const bar = barDays(project.start_date, project.target_date);
      if (bar !== null)
        lanes.set(project.project_id, { centre: top + LANE_HEIGHT / 2, bar });
      top += LANE_HEIGHT;
    }
  }
  return lanes;
};

/**
 * Every dependency line between two dated projects on the timeline, drawn
 * from the blocked side's list so each pair is drawn once.
 */
export const dependencyLines = (
  groups: ProjectGroup[],
  folded: readonly string[],
  range: TimelineRange,
  pxPerDay: number
): DependencyLine[] => {
  const lanes = placeLanes(groups, folded);
  const lines: DependencyLine[] = [];
  for (const group of groups) {
    for (const project of group.rows) {
      const blocked = lanes.get(project.project_id);
      if (blocked === undefined) continue;
      for (const blockerId of project.blocked_by_project_ids ?? []) {
        const blocker = lanes.get(blockerId);
        if (blocker === undefined) continue;
        lines.push({
          key: `${blockerId}:${project.project_id}`,
          blockerId,
          blockedId: project.project_id,
          fromX: (blocker.bar.end + 1 - range.start) * pxPerDay,
          fromY: blocker.centre,
          toX: (blocked.bar.start - range.start) * pxPerDay,
          toY: blocked.centre,
          late: blocked.bar.start <= blocker.bar.end,
        });
      }
    }
  }
  return lines;
};

/**
 * The SVG path for one line: out of the blocker to the right, into the
 * blocked bar from the left, curving back on itself when the waiting bar
 * starts first.
 */
export const dependencyPath = (line: DependencyLine): string => {
  const reach = Math.max(16, Math.min(48, Math.abs(line.toX - line.fromX) / 2));
  const fromX = String(line.fromX);
  const toX = String(line.toX);
  return `M ${fromX} ${String(line.fromY)} C ${String(line.fromX + reach)} ${String(line.fromY)} ${String(line.toX - reach)} ${String(line.toY)} ${toX} ${String(line.toY)}`;
};

/** A dependency drawn or removed on the timeline before the server answers. */
export interface PendingLink {
  blockerId: string;
  blockedId: string;
  /** True while the link is being removed rather than added. */
  removing: boolean;
}

/** The key a dependency line is drawn under, blocker first. */
export const linkKey = (blockerId: string, blockedId: string): string =>
  `${blockerId}:${blockedId}`;

/** One id list with an id added once, or taken off. */
const adjust = (ids: string[], id: string, removing: boolean): string[] =>
  removing
    ? ids.filter((held) => held !== id)
    : ids.includes(id)
      ? ids
      : [...ids, id];

/**
 * The groups as they read once the pending links land, so a link dragged on
 * the timeline draws at once and a removed one goes at once.
 */
export const withPendingLinks = (
  groups: ProjectGroup[],
  pending: readonly PendingLink[]
): ProjectGroup[] => {
  if (pending.length === 0) return groups;
  return groups.map((group) => ({
    ...group,
    rows: group.rows.map((project) => {
      let blockedBy = project.blocked_by_project_ids ?? [];
      let blocking = project.blocking_project_ids ?? [];
      for (const link of pending) {
        if (link.blockedId === project.project_id)
          blockedBy = adjust(blockedBy, link.blockerId, link.removing);
        if (link.blockerId === project.project_id)
          blocking = adjust(blocking, link.blockedId, link.removing);
      }
      return {
        ...project,
        blocked_by_project_ids: blockedBy,
        blocking_project_ids: blocking,
      };
    }),
  }));
};

/** Which end of a bar a link is dragged from. */
export type LinkSide = 'start' | 'end';

/**
 * The dependency a drag makes. Dragging from the end of a bar makes that
 * project block the one it lands on, and dragging from the start makes it
 * wait on that one.
 */
export const linkFromDrag = (
  side: LinkSide,
  sourceId: string,
  targetId: string
): { blockerId: string; blockedId: string } =>
  side === 'end'
    ? { blockerId: sourceId, blockedId: targetId }
    : { blockerId: targetId, blockedId: sourceId };

/** The SVG path of a link being dragged, from its bar end to the pointer. */
export const draftPath = (
  side: LinkSide,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): string => {
  const reach = Math.max(16, Math.min(48, Math.abs(toX - fromX) / 2));
  const out = side === 'end' ? reach : -reach;
  return `M ${String(fromX)} ${String(fromY)} C ${String(fromX + out)} ${String(fromY)} ${String(toX - out)} ${String(toY)} ${String(toX)} ${String(toY)}`;
};
