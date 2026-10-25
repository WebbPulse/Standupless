/**
 * The rows the initiatives timeline draws. Each top level initiative opens a
 * branch with its sub-initiatives and then its own projects nested below it,
 * and a collapsed initiative hides everything under it. A branch with no date
 * anywhere in it, on an initiative or on a project, sits in the No dates
 * section below the dated ones, the way Linear keeps unscheduled work apart.
 * Every walk carries a visited set, so a cycle reads as a cut branch.
 */

import { childrenByParent } from './initiativeTree';
import { dayValue, type BarDays, type DragMode } from './timeline';
import type { InitiativeMove } from '../hooks/useInitiativeMoves';
import type { InitiativeRead, ProjectRead } from '../types/Api';

/** An initiative lane: its depth, and how many rows it can fold away. */
export interface InitiativeLane {
  kind: 'initiative';
  key: string;
  initiative: InitiativeRead;
  depth: number;
  /** How many sub-initiatives and projects sit directly below it. */
  childCount: number;
}

/** A project lane nested under the initiative that holds it. */
export interface ProjectLane {
  kind: 'project';
  key: string;
  project: ProjectRead;
  depth: number;
}

/** One lane of the initiatives timeline. */
export type InitiativeTimelineLane = InitiativeLane | ProjectLane;

/** The lanes split into the dated branches and the No dates section. */
export interface InitiativeTimelineRows {
  dated: InitiativeTimelineLane[];
  undated: InitiativeTimelineLane[];
}

/** Whether a lane carries a start or a target date. */
export const laneHasDates = (lane: InitiativeTimelineLane): boolean => {
  const item = lane.kind === 'initiative' ? lane.initiative : lane.project;
  return item.start_date != null || item.target_date != null;
};

/** Every date the lanes draw, so the timeline's range can be fitted to them. */
export const laneDates = (
  lanes: readonly InitiativeTimelineLane[]
): (string | null)[] =>
  lanes.flatMap((lane) => {
    const item = lane.kind === 'initiative' ? lane.initiative : lane.project;
    return [item.start_date ?? null, item.target_date ?? null];
  });

/**
 * The initiatives, in the page's order, as nested lanes split into dated
 * branches and the No dates section. `projects` is every project the person
 * can see; an initiative's projects are drawn in that list's order.
 */
export const initiativeTimelineRows = (
  initiatives: InitiativeRead[],
  projects: readonly ProjectRead[],
  collapsed: ReadonlySet<string>
): InitiativeTimelineRows => {
  const shown = new Set(initiatives.map((row) => row.initiative_id));
  const children = childrenByParent(initiatives);
  const projectsOf = (initiative: InitiativeRead): ProjectRead[] => {
    const held = new Set(initiative.project_ids);
    return projects.filter((project) => held.has(project.project_id));
  };
  const placed = new Set<string>();
  const dated: InitiativeTimelineLane[] = [];
  const undated: InitiativeTimelineLane[] = [];

  const branch = (root: InitiativeRead): void => {
    const lanes: InitiativeTimelineLane[] = [];
    let anyDate = false;
    const visit = (
      initiative: InitiativeRead,
      depth: number,
      hidden: boolean
    ): void => {
      if (placed.has(initiative.initiative_id)) return;
      placed.add(initiative.initiative_id);
      const below = (children.get(initiative.initiative_id) ?? []).filter(
        (child) => !placed.has(child.initiative_id)
      );
      const held = projectsOf(initiative);
      const lane: InitiativeLane = {
        kind: 'initiative',
        key: `initiative:${initiative.initiative_id}`,
        initiative,
        depth,
        childCount: below.length + held.length,
      };
      if (laneHasDates(lane)) anyDate = true;
      if (!hidden) lanes.push(lane);
      const folds = hidden || collapsed.has(initiative.initiative_id);
      for (const child of below) visit(child, depth + 1, folds);
      for (const project of held) {
        const projectLane: ProjectLane = {
          kind: 'project',
          key: `project:${initiative.initiative_id}:${project.project_id}`,
          project,
          depth: depth + 1,
        };
        if (laneHasDates(projectLane)) anyDate = true;
        if (!folds) lanes.push(projectLane);
      }
    };
    visit(root, 0, false);
    (anyDate ? dated : undated).push(...lanes);
  };

  for (const row of initiatives) {
    const parent = row.parent_initiative_id ?? null;
    if (parent === null || !shown.has(parent) || parent === row.initiative_id)
      branch(row);
  }
  for (const row of initiatives) {
    if (!placed.has(row.initiative_id)) branch(row);
  }
  return { dated, undated };
};

/** The dates an initiative holds now, written back when a change is undone. */
export const heldDates = (initiative: InitiativeRead): InitiativeMove => ({
  start_date: initiative.start_date ?? null,
  start_date_resolution: initiative.start_date_resolution ?? null,
  target_date: initiative.target_date,
  target_date_resolution: initiative.target_date_resolution ?? null,
});

/**
 * The change a drag writes. Only the dates the drag moved are sent, so an
 * initiative with only a target still has no start after its bar moves, and
 * a moved date is a plain day again.
 */
export const dragChange = (
  initiative: InitiativeRead,
  mode: DragMode,
  next: BarDays
): InitiativeMove => {
  const hasStart = initiative.start_date != null;
  const hasTarget = initiative.target_date != null;
  const start = { start_date: dayValue(next.start) };
  const end = { target_date: dayValue(next.end) };
  if (mode === 'start') return start;
  if (mode === 'end') return end;
  return {
    ...(hasStart ? start : {}),
    ...(hasTarget || !hasStart ? end : {}),
  };
};
