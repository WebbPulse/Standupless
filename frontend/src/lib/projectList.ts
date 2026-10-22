/**
 * How the projects list lays out, orders, groups and windows its rows. Kept
 * apart from the page so the choices can be tested against fixed rows, and
 * so the roadmap can group its lanes the same way.
 */

import { progressPercent, PROJECT_STATUS_LABELS } from './planningDisplay';
import { PROJECT_STATUS_ORDER } from './planningModel';
import { personLabel, type Assignable } from './issuePeople';
import { PRIORITY_LABELS } from './issueDisplay';
import { PROJECT_HEALTHS, PROJECT_HEALTH_LABELS } from './projectLook';
import { TIMELINE_ZOOMS, type TimelineZoom } from './timeline';
import type {
  IssuePriority,
  ProjectHealth,
  ProjectRead,
  TeamRead,
} from '../types/Api';

/** How the projects page draws its rows. */
export type ProjectLayout = 'list' | 'board' | 'timeline';

/** The layouts in the order the display menu offers them. */
export const PROJECT_LAYOUTS: ProjectLayout[] = ['list', 'board', 'timeline'];

/** How each layout reads in the display menu. */
export const PROJECT_LAYOUT_LABELS: Record<ProjectLayout, string> = {
  list: 'List',
  board: 'Board',
  timeline: 'Timeline',
};

/** What the projects list can order by. */
export type ProjectOrdering =
  'target' | 'start' | 'name' | 'priority' | 'progress' | 'created' | 'updated';

/** The orderings in the order the display menu offers them. */
export const PROJECT_ORDERINGS: ProjectOrdering[] = [
  'target',
  'start',
  'name',
  'priority',
  'progress',
  'created',
  'updated',
];

/** How each ordering reads in the display menu. */
export const PROJECT_ORDERING_LABELS: Record<ProjectOrdering, string> = {
  target: 'Target date',
  start: 'Start date',
  name: 'Name',
  priority: 'Priority',
  progress: 'Progress',
  created: 'Created',
  updated: 'Last updated',
};

/** What the projects list can group by. */
export type ProjectGrouping =
  'status' | 'health' | 'priority' | 'initiative' | 'lead' | 'team' | 'none';

/** The groupings in the order the display menu offers them. */
export const PROJECT_GROUPINGS: ProjectGrouping[] = [
  'status',
  'health',
  'priority',
  'initiative',
  'lead',
  'team',
  'none',
];

/** How each grouping reads in the display menu. */
export const PROJECT_GROUPING_LABELS: Record<ProjectGrouping, string> = {
  status: 'Status',
  health: 'Health',
  priority: 'Priority',
  initiative: 'Initiative',
  lead: 'Lead',
  team: 'Team',
  none: 'No grouping',
};

/** Which completed and canceled projects the list keeps. */
export type ClosedWindow = 'all' | 'week' | 'month' | 'quarter' | 'none';

/** The windows in the order the display menu offers them. */
export const CLOSED_WINDOWS: ClosedWindow[] = [
  'all',
  'week',
  'month',
  'quarter',
  'none',
];

/** How each window reads in the display menu. */
export const CLOSED_WINDOW_LABELS: Record<ClosedWindow, string> = {
  all: 'All',
  week: 'Past week',
  month: 'Past month',
  quarter: 'Past quarter',
  none: 'None',
};

/** How many days back each recent window reaches. */
const CLOSED_WINDOW_DAYS: Record<'week' | 'month' | 'quarter', number> = {
  week: 7,
  month: 30,
  quarter: 90,
};

/** The whole projects display, as the account stores it. */
export interface ProjectsDisplay {
  layout: ProjectLayout;
  group: ProjectGrouping;
  order: ProjectOrdering;
  closed: ClosedWindow;
  zoom: TimelineZoom;
}

/** What a person who never arranged the page sees, matching the server. */
export const DEFAULT_PROJECTS_DISPLAY: ProjectsDisplay = {
  layout: 'list',
  group: 'status',
  order: 'target',
  closed: 'all',
  zoom: 'month',
};

/** The choices each display field accepts, for reading URL values. */
const DISPLAY_CHOICES: { [K in keyof ProjectsDisplay]: readonly string[] } = {
  layout: PROJECT_LAYOUTS,
  group: PROJECT_GROUPINGS,
  order: PROJECT_ORDERINGS,
  closed: CLOSED_WINDOWS,
  zoom: TIMELINE_ZOOMS,
};

/** The display fields, in the order they are written to the URL. */
export const PROJECTS_DISPLAY_FIELDS = Object.keys(
  DISPLAY_CHOICES
) as (keyof ProjectsDisplay)[];

/**
 * Reads one display field from a URL or stored value, or undefined when the
 * value is missing or not a choice the page knows.
 */
export const parseDisplayField = <K extends keyof ProjectsDisplay>(
  field: K,
  value: string | null | undefined
): ProjectsDisplay[K] | undefined =>
  value !== null &&
  value !== undefined &&
  DISPLAY_CHOICES[field].includes(value)
    ? (value as ProjectsDisplay[K])
    : undefined;

/**
 * The display in force: each field from the URL when it names a known
 * choice, otherwise from what the account saved, otherwise the default.
 */
export const resolveDisplay = (
  read: (field: keyof ProjectsDisplay) => string | null,
  saved: Partial<ProjectsDisplay> | undefined
): ProjectsDisplay => {
  const pick = <K extends keyof ProjectsDisplay>(
    field: K
  ): ProjectsDisplay[K] =>
    parseDisplayField(field, read(field)) ??
    parseDisplayField(field, saved?.[field]) ??
    DEFAULT_PROJECTS_DISPLAY[field];
  return {
    layout: pick('layout'),
    group: pick('group'),
    order: pick('order'),
    closed: pick('closed'),
    zoom: pick('zoom'),
  };
};

/** Whether a project is completed or canceled. */
export const isClosedProject = (project: ProjectRead): boolean =>
  project.status === 'completed' || project.status === 'canceled';

/**
 * Whether a project stays in the list under a completed projects window.
 * Open projects always stay. A closed one is judged by when it closed, or by
 * its last update on a row closed before the close time was recorded.
 */
export const withinClosedWindow = (
  project: ProjectRead,
  closed: ClosedWindow,
  now: Date
): boolean => {
  if (!isClosedProject(project) || closed === 'all') return true;
  if (closed === 'none') return false;
  const closedAt = Date.parse(project.completed_at ?? project.updated_at);
  if (Number.isNaN(closedAt)) return true;
  return now.getTime() - closedAt <= CLOSED_WINDOW_DAYS[closed] * 86400000;
};

/** Reads an ordering from a URL value, falling back to target date. */
export const parseOrdering = (value: string | null): ProjectOrdering =>
  PROJECT_ORDERINGS.includes(value as ProjectOrdering)
    ? (value as ProjectOrdering)
    : 'target';

/** Reads a grouping from a URL value, falling back to the page's own. */
export const parseGrouping = (
  value: string | null,
  fallback: ProjectGrouping = 'status'
): ProjectGrouping =>
  PROJECT_GROUPINGS.includes(value as ProjectGrouping)
    ? (value as ProjectGrouping)
    : fallback;

/** How urgent each priority runs, so "no priority" sorts after low. */
const PRIORITY_RANK: Record<IssuePriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

/** The priorities in the order their groups run, urgent first. */
export const PROJECT_PRIORITY_ORDER: IssuePriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];

/** Compares two nullable day values, the missing one last. */
const byDate = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
};

/**
 * Sorts projects by an ordering. Dates run soonest first with undated rows
 * last, priority runs urgent first with no priority last, progress and
 * timestamps run highest and newest first, and every tie falls back to the
 * name so the order is stable.
 */
export const sortProjects = (
  projects: ProjectRead[],
  ordering: ProjectOrdering
): ProjectRead[] => {
  const compare = (left: ProjectRead, right: ProjectRead): number => {
    switch (ordering) {
      case 'target':
        return byDate(left.target_date, right.target_date);
      case 'start':
        return byDate(left.start_date, right.start_date);
      case 'priority':
        return PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
      case 'progress':
        return progressPercent(right) - progressPercent(left);
      case 'created':
        return right.created_at.localeCompare(left.created_at);
      case 'updated':
        return right.updated_at.localeCompare(left.updated_at);
      case 'name':
        return 0;
    }
  };
  return [...projects].sort(
    (left, right) => compare(left, right) || left.name.localeCompare(right.name)
  );
};

/** One labelled group of projects. `key` is stable across reads. */
export interface ProjectGroup {
  key: string;
  label: string;
  kind: ProjectGrouping;
  rows: ProjectRead[];
}

/** The group key projects with no lead sit under. */
export const NO_LEAD_KEY = 'lead:none';

/** The group key projects outside any initiative sit under. */
export const NO_INITIATIVE_KEY = 'initiative:none';

/** The group key projects nobody has judged the health of sit under. */
export const NO_HEALTH_KEY = 'health:none';

/** An initiative as grouping needs it: its id and name. */
export interface InitiativeName {
  initiative_id: string;
  name: string;
}

/** Options for groupProjects beyond the rows and the grouping. */
export interface GroupOptions {
  /** The workspace's initiatives, to name initiative groups. */
  initiatives?: InitiativeName[];
  /** Keeps every group a project could be moved into, even empty, for the board. */
  keepEmpty?: boolean;
}

/**
 * Groups projects that share one value, in the order the values are given,
 * with values outside the list appended by label after them.
 */
const byValue = (
  projects: ProjectRead[],
  kind: ProjectGrouping,
  valueOf: (project: ProjectRead) => string,
  known: { value: string; label: string }[],
  labelFor: (value: string) => string,
  keepEmpty: boolean,
  last?: { value: string; label: string }
): ProjectGroup[] => {
  const held = new Map<string, ProjectRead[]>();
  for (const project of projects) {
    const value = valueOf(project);
    held.set(value, [...(held.get(value) ?? []), project]);
  }
  const knownValues = new Set(known.map((item) => item.value));
  if (last !== undefined) knownValues.add(last.value);
  const extra = [...held.keys()]
    .filter((value) => !knownValues.has(value))
    .map((value) => ({ value, label: labelFor(value) }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const ordered = [...known, ...extra, ...(last === undefined ? [] : [last])];
  return ordered
    .map(({ value, label }) => ({
      key: `${kind}:${value}`,
      label,
      kind,
      rows: held.get(value) ?? [],
    }))
    .filter((group) => keepEmpty || group.rows.length > 0);
};

/**
 * Groups already sorted projects. Status groups run in the list's order,
 * health from on track to no updates, priority from urgent to none,
 * initiatives and leads by name with the empty group last, and team groups
 * in the teams' order; a project on several teams shows under each of them.
 * Empty groups are left out unless asked for, and "none" is one unlabelled
 * group.
 */
export const groupProjects = (
  projects: ProjectRead[],
  grouping: ProjectGrouping,
  people: Assignable[],
  teams: TeamRead[],
  options: GroupOptions = {}
): ProjectGroup[] => {
  const keepEmpty = options.keepEmpty ?? false;
  switch (grouping) {
    case 'none':
      return [{ key: 'all', label: 'Projects', kind: 'none', rows: projects }];
    case 'status':
      return byValue(
        projects,
        grouping,
        (project) => project.status,
        PROJECT_STATUS_ORDER.map((status) => ({
          value: status,
          label: PROJECT_STATUS_LABELS[status],
        })),
        (value) => value,
        keepEmpty
      );
    case 'health':
      return byValue(
        projects,
        grouping,
        (project) => project.health ?? 'none',
        PROJECT_HEALTHS.map((health) => ({
          value: health,
          label: PROJECT_HEALTH_LABELS[health],
        })),
        (value) => value,
        keepEmpty,
        { value: 'none', label: 'No updates' }
      );
    case 'priority':
      return byValue(
        projects,
        grouping,
        (project) => project.priority,
        PROJECT_PRIORITY_ORDER.map((priority) => ({
          value: priority,
          label: PRIORITY_LABELS[priority],
        })),
        (value) => value,
        keepEmpty
      );
    case 'initiative': {
      const initiatives = [...(options.initiatives ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      return byValue(
        projects,
        grouping,
        (project) => project.initiative_id ?? 'none',
        keepEmpty
          ? initiatives.map((item) => ({
              value: item.initiative_id,
              label: item.name,
            }))
          : [],
        (value) =>
          initiatives.find((item) => item.initiative_id === value)?.name ??
          'Unknown initiative',
        keepEmpty,
        { value: 'none', label: 'No initiative' }
      );
    }
    case 'team':
      return teams
        .map((team) => ({
          key: `team:${team.id}`,
          label: team.name,
          kind: grouping,
          rows: projects.filter((project) =>
            project.team_ids.includes(team.id)
          ),
        }))
        .filter((group) => keepEmpty || group.rows.length > 0);
    case 'lead':
      return byValue(
        projects,
        grouping,
        (project) => project.lead_id ?? 'none',
        [],
        (value) => {
          const person = people.find((item) => item.user_id === value);
          return person === undefined ? 'Unknown lead' : personLabel(person);
        },
        keepEmpty,
        { value: 'none', label: 'No lead' }
      );
  }
};

/** The value a group key carries after its kind, such as `on_track`. */
export const groupValue = (group: ProjectGroup): string =>
  group.key.slice(group.kind.length + 1);

/** The fields a move between board columns can change. */
export type ProjectMove = Partial<
  Pick<
    ProjectRead,
    'status' | 'health' | 'priority' | 'initiative_id' | 'lead_id'
  >
>;

/**
 * The change that moves a project into a group on the board, or null when
 * the group is not one value a project holds, such as a team.
 */
export const groupPatch = (group: ProjectGroup): ProjectMove | null => {
  const value = groupValue(group);
  switch (group.kind) {
    case 'status':
      return { status: value as ProjectRead['status'] };
    case 'health':
      return { health: value === 'none' ? null : (value as ProjectHealth) };
    case 'priority':
      return { priority: value as IssuePriority };
    case 'initiative':
      return { initiative_id: value === 'none' ? null : value };
    case 'lead':
      return { lead_id: value === 'none' ? null : value };
    case 'team':
    case 'none':
      return null;
  }
};

/** Whether a project already sits in a group, so a drop there changes nothing. */
export const inGroup = (project: ProjectRead, group: ProjectGroup): boolean => {
  const value = groupValue(group);
  switch (group.kind) {
    case 'status':
      return project.status === value;
    case 'health':
      return (project.health ?? 'none') === value;
    case 'priority':
      return project.priority === value;
    case 'initiative':
      return (project.initiative_id ?? 'none') === value;
    case 'lead':
      return (project.lead_id ?? 'none') === value;
    case 'team':
      return project.team_ids.includes(value);
    case 'none':
      return true;
  }
};
