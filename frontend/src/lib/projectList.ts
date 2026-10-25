/**
 * How the projects list lays out, orders, groups and windows its rows. Kept
 * apart from the page so the choices can be tested against fixed rows, and
 * so the roadmap can group its lanes the same way.
 */

import { orderBetween } from '../api/issues';
import { progressPercent } from './planningDisplay';
import {
  DEFAULT_PROJECT_STATUSES,
  listOrderedProjectStatuses,
  projectStatusOf,
} from './projectStatuses';
import { personLabel, type Assignable } from './issuePeople';
import { PRIORITY_LABELS } from './issueDisplay';
import { PROJECT_HEALTHS, PROJECT_HEALTH_LABELS } from './projectLook';
import { TIMELINE_ZOOMS, type TimelineZoom } from './timeline';
import type {
  IssuePriority,
  ProjectHealth,
  ProjectRead,
  ProjectStatus,
  ProjectStatusRead,
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
  | 'manual'
  | 'target'
  | 'start'
  | 'name'
  | 'priority'
  | 'progress'
  | 'created'
  | 'updated'
  | 'customers'
  | 'important';

/** The orderings in the order the display menu offers them. */
export const PROJECT_ORDERINGS: ProjectOrdering[] = [
  'manual',
  'target',
  'start',
  'name',
  'priority',
  'progress',
  'created',
  'updated',
  'customers',
  'important',
];

/** The orderings that read who asked for each project, which guests may not. */
export const CUSTOMER_PROJECT_ORDERINGS: ReadonlySet<ProjectOrdering> = new Set(
  ['customers', 'important']
);

/** How each ordering reads in the display menu. */
export const PROJECT_ORDERING_LABELS: Record<ProjectOrdering, string> = {
  manual: 'Manual',
  target: 'Target date',
  start: 'Start date',
  name: 'Name',
  priority: 'Priority',
  progress: 'Progress',
  created: 'Created',
  updated: 'Last updated',
  customers: 'Customer requests',
  important: 'Important customer requests',
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

/** Which closed projects the list keeps: all, recently completed ones, or none. */
export type ClosedWindow = 'all' | 'fortnight' | 'month' | 'none';

/** The windows in the order the display menu offers them. */
export const CLOSED_WINDOWS: ClosedWindow[] = [
  'all',
  'fortnight',
  'month',
  'none',
];

/** How each window reads in the display menu. */
export const CLOSED_WINDOW_LABELS: Record<ClosedWindow, string> = {
  all: 'All',
  fortnight: 'Past 2 weeks',
  month: 'Past month',
  none: 'None',
};

/** How many days back each recent window reaches. */
const CLOSED_WINDOW_DAYS: Record<'fortnight' | 'month', number> = {
  fortnight: 14,
  month: 30,
};

/** A property the projects list and board can show beside each project's name. */
export type ProjectColumn =
  | 'summary'
  | 'milestones'
  | 'dependencies'
  | 'health'
  | 'priority'
  | 'status'
  | 'lead'
  | 'members'
  | 'start'
  | 'target'
  | 'teams'
  | 'issues'
  | 'important'
  | 'created'
  | 'updated'
  | 'completed'
  | 'progress'
  | 'labels'
  | 'id';

/** The properties in the order the list draws them, matching the server. */
export const PROJECT_COLUMNS: ProjectColumn[] = [
  'summary',
  'milestones',
  'dependencies',
  'labels',
  'health',
  'priority',
  'status',
  'lead',
  'members',
  'start',
  'target',
  'teams',
  'issues',
  'important',
  'created',
  'updated',
  'completed',
  'progress',
  'id',
];

/** The properties in the order the display menu offers them as chips. */
export const PROJECT_COLUMN_CHIPS: ProjectColumn[] = [
  'milestones',
  'summary',
  'id',
  'priority',
  'status',
  'health',
  'labels',
  'teams',
  'lead',
  'members',
  'dependencies',
  'start',
  'target',
  'issues',
  'important',
  'created',
  'updated',
  'completed',
  'progress',
];

/** The properties the timeline can show beside each name and on each bar, in chip order. */
export const TIMELINE_PROJECT_COLUMNS: ProjectColumn[] = [
  'priority',
  'status',
  'health',
  'teams',
  'lead',
  'progress',
];

/** The properties drawn inline after the name rather than in a column of their own. */
export const INLINE_PROJECT_COLUMNS: ReadonlySet<ProjectColumn> = new Set([
  'summary',
  'milestones',
  'dependencies',
  'labels',
]);

/** How each property reads in the display menu and the list header. */
export const PROJECT_COLUMN_LABELS: Record<ProjectColumn, string> = {
  summary: 'Summary',
  milestones: 'Milestones',
  dependencies: 'Dependencies',
  health: 'Health',
  priority: 'Priority',
  status: 'Status',
  lead: 'Lead',
  members: 'Members',
  start: 'Start date',
  target: 'Target date',
  teams: 'Teams',
  issues: 'Issues',
  important: 'Important requests',
  created: 'Created',
  updated: 'Updated',
  completed: 'Completed',
  progress: 'Progress',
  labels: 'Labels',
  id: 'ID',
};

/** The properties a person who never chose sees, matching the server. */
export const DEFAULT_PROJECT_COLUMNS =
  'summary,dependencies,health,priority,status,lead,start,target,teams,progress';

/** The known columns a stored or URL value names, in drawing order. */
export const columnList = (value: string): ProjectColumn[] => {
  const named = value.split(',').map((token) => token.trim());
  return PROJECT_COLUMNS.filter((column) => named.includes(column));
};

/** A column choice written the one way the account, the URL and views store it. */
export const columnValue = (columns: readonly ProjectColumn[]): string =>
  PROJECT_COLUMNS.filter((column) => columns.includes(column)).join(',');

/** Whether groups run in their own order or reversed. */
export type GroupDirection = 'asc' | 'desc';

/** The group directions, for reading URL values. */
export const GROUP_DIRECTIONS: GroupDirection[] = ['asc', 'desc'];

/** Whether a team's projects page keeps every project on the team or only those it leads. */
export type LeadTeamChoice = 'all' | 'lead';

/** The lead team choices, for reading URL values. */
export const LEAD_TEAM_CHOICES: LeadTeamChoice[] = ['all', 'lead'];

/** Whether the board shows columns that hold no project. */
export type EmptyColumnsChoice = 'show' | 'hide';

/** The empty column choices, for reading URL values. */
export const EMPTY_COLUMNS_CHOICES: EmptyColumnsChoice[] = ['show', 'hide'];

/** Whether the timeline draws the lines between blocking and blocked projects. */
export type DependencyLinesChoice = 'show' | 'hide';

/** The dependency line choices, for reading URL values. */
export const DEPENDENCY_LINES_CHOICES: DependencyLinesChoice[] = [
  'show',
  'hide',
];

/** The whole projects display, as the account stores it. */
export interface ProjectsDisplay {
  layout: ProjectLayout;
  group: ProjectGrouping;
  direction: GroupDirection;
  /** The grouping inside each group, `none` for a single level. */
  rows: ProjectGrouping;
  order: ProjectOrdering;
  closed: ClosedWindow;
  lead_team: LeadTeamChoice;
  empty: EmptyColumnsChoice;
  zoom: TimelineZoom;
  /** Whether the timeline draws its dependency lines. */
  dependencies: DependencyLinesChoice;
  /** The shown list columns, comma separated in drawing order. */
  columns: string;
}

/** What a person who never arranged the page sees, matching the server. */
export const DEFAULT_PROJECTS_DISPLAY: ProjectsDisplay = {
  layout: 'list',
  group: 'status',
  direction: 'asc',
  rows: 'none',
  order: 'target',
  closed: 'fortnight',
  lead_team: 'all',
  empty: 'show',
  zoom: 'month',
  dependencies: 'show',
  columns: DEFAULT_PROJECT_COLUMNS,
};

/** The display fields that hold one choice from a fixed set. */
type ChoiceField = Exclude<keyof ProjectsDisplay, 'columns'>;

/** The choices each single choice display field accepts, for reading URL values. */
const DISPLAY_CHOICES: { [K in ChoiceField]: readonly string[] } = {
  layout: PROJECT_LAYOUTS,
  group: PROJECT_GROUPINGS,
  direction: GROUP_DIRECTIONS,
  rows: PROJECT_GROUPINGS,
  order: PROJECT_ORDERINGS,
  closed: CLOSED_WINDOWS,
  lead_team: LEAD_TEAM_CHOICES,
  empty: EMPTY_COLUMNS_CHOICES,
  zoom: TIMELINE_ZOOMS,
  dependencies: DEPENDENCY_LINES_CHOICES,
};

/** The display fields, in the order they are written to the URL. */
export const PROJECTS_DISPLAY_FIELDS: (keyof ProjectsDisplay)[] = [
  ...(Object.keys(DISPLAY_CHOICES) as ChoiceField[]),
  'columns',
];

/**
 * Reads one display field from a URL or stored value, or undefined when the
 * value is missing or not a choice the page knows. Columns keep the known
 * names in drawing order, and an empty value means every column is hidden.
 */
export const parseDisplayField = <K extends keyof ProjectsDisplay>(
  field: K,
  value: string | null | undefined
): ProjectsDisplay[K] | undefined => {
  if (value === null || value === undefined) return undefined;
  if (field === 'columns')
    return columnValue(columnList(value)) as ProjectsDisplay[K];
  const choices: Partial<Record<keyof ProjectsDisplay, readonly string[]>> =
    DISPLAY_CHOICES;
  return choices[field]?.includes(value) === true
    ? (value as ProjectsDisplay[K])
    : undefined;
};

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
    direction: pick('direction'),
    rows: pick('rows'),
    order: pick('order'),
    closed: pick('closed'),
    lead_team: pick('lead_team'),
    empty: pick('empty'),
    zoom: pick('zoom'),
    dependencies: pick('dependencies'),
    columns: pick('columns'),
  };
};

/** Whether a project is completed or canceled. */
export const isClosedProject = (project: ProjectRead): boolean =>
  project.status === 'completed' || project.status === 'canceled';

/**
 * Whether a project stays in the list under a closed projects window.
 * Open projects always stay, and canceled ones only under `all`. A completed
 * one is judged by when it closed, or by its last update on a row closed
 * before the close time was recorded.
 */
export const withinClosedWindow = (
  project: ProjectRead,
  closed: ClosedWindow,
  now: Date
): boolean => {
  if (!isClosedProject(project) || closed === 'all') return true;
  if (closed === 'none' || project.status === 'canceled') return false;
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
 * Compares two projects in the shared manual order: placed projects by their
 * key, then projects never placed, newest first, the way new ones arrive.
 */
const byManual = (left: ProjectRead, right: ProjectRead): number => {
  const leftKey = left.sort_order ?? null;
  const rightKey = right.sort_order ?? null;
  if (leftKey !== null && rightKey !== null) {
    if (leftKey === rightKey) return 0;
    return leftKey < rightKey ? -1 : 1;
  }
  if (leftKey !== null) return -1;
  if (rightKey !== null) return 1;
  return right.created_at.localeCompare(left.created_at);
};

/**
 * Sorts projects by an ordering. Manual runs by the stored rank, dates run
 * soonest first with undated rows last, priority runs urgent first with no
 * priority last, progress and timestamps run highest and newest first, and
 * every tie falls back to the name so the order is stable.
 */
export const sortProjects = (
  projects: ProjectRead[],
  ordering: ProjectOrdering
): ProjectRead[] => {
  const compare = (left: ProjectRead, right: ProjectRead): number => {
    switch (ordering) {
      case 'manual':
        return byManual(left, right);
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
      case 'customers':
        return (
          (right.customer_request_count ?? 0) -
          (left.customer_request_count ?? 0)
        );
      case 'important':
        return (
          (right.customer_important_count ?? 0) -
          (left.customer_important_count ?? 0)
        );
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
  /** A status group's category, which a move into it sets beside the status id. */
  category?: ProjectStatus;
  /** Whether a status group is its category's default, where a bare category lands. */
  isDefaultStatus?: boolean;
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
  /** The filtered team and the sub-teams it rolls up, which alone get team groups. */
  teamIds?: readonly string[] | null;
  /** The workspace's project statuses, which status groups run by. */
  statuses?: readonly ProjectStatusRead[];
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
 * in the teams' order; a project on several teams shows under each of them,
 * or once under the first filtered team it is on when a team filter is set.
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
    case 'status': {
      const statuses = options.statuses ?? DEFAULT_PROJECT_STATUSES;
      const byId = new Map(statuses.map((status) => [status.id, status]));
      return byValue(
        projects,
        grouping,
        (project) => projectStatusOf(project, statuses).id,
        listOrderedProjectStatuses(statuses).map((status) => ({
          value: status.id,
          label: status.name,
        })),
        (value) => value,
        keepEmpty
      ).map((group) => {
        const status = byId.get(groupValue(group));
        return status === undefined
          ? group
          : {
              ...group,
              category: status.category,
              isDefaultStatus: status.is_default,
            };
      });
    }
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
    case 'team': {
      const filter = options.teamIds ?? null;
      const shown =
        filter === null
          ? teams
          : teams.filter((team) => filter.includes(team.id));
      const home = (project: ProjectRead): string | undefined =>
        shown.find((team) => project.team_ids.includes(team.id))?.id;
      return shown
        .map((team) => ({
          key: `team:${team.id}`,
          label: team.name,
          kind: grouping,
          rows: projects.filter((project) =>
            filter === null
              ? project.team_ids.includes(team.id)
              : home(project) === team.id
          ),
        }))
        .filter((group) => keepEmpty || group.rows.length > 0);
    }
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

/** Groups in the chosen direction: their own order, or reversed. */
export const directedGroups = (
  groups: ProjectGroup[],
  direction: GroupDirection
): ProjectGroup[] => (direction === 'desc' ? [...groups].reverse() : groups);

/** The second level grouping in force: none when it repeats the first or the first is none. */
export const effectiveRows = (
  grouping: ProjectGrouping,
  rows: ProjectGrouping
): ProjectGrouping =>
  grouping === 'none' || rows === grouping ? 'none' : rows;

/**
 * Whether a project stays on a team's projects page under the lead team
 * choice: every project on the team, or only those whose lead team is one of
 * `teamIds`, the team and the sub-teams it rolls up.
 */
export const withinLeadTeams = (
  project: ProjectRead,
  choice: LeadTeamChoice,
  teamIds: readonly string[] | null
): boolean =>
  choice === 'all' || teamIds === null || teamIds.includes(project.team_id);

/** The value a group key carries after its kind, such as `on_track`. */
export const groupValue = (group: ProjectGroup): string =>
  group.key.slice(group.kind.length + 1);

/** The fields a board move, a reorder or a card edit can change. */
export type ProjectMove = Partial<
  Pick<
    ProjectRead,
    | 'status'
    | 'status_id'
    | 'health'
    | 'priority'
    | 'initiative_id'
    | 'lead_id'
    | 'start_date'
    | 'target_date'
    | 'member_ids'
    | 'label_ids'
  >
> & { sort_order?: string };

/**
 * The change that moves a project into a group on the board, or null when
 * the group is not one value a project holds, such as a team. A move into a
 * category's default status from another category names only the category.
 */
export const groupPatch = (
  group: ProjectGroup,
  project?: ProjectRead
): ProjectMove | null => {
  const value = groupValue(group);
  switch (group.kind) {
    case 'status':
      if (group.category === undefined)
        return { status: value as ProjectStatus };
      return group.isDefaultStatus === true &&
        project !== undefined &&
        project.status !== group.category
        ? { status: group.category }
        : { status: group.category, status_id: value };
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
      return (project.status_id ?? project.status) === value;
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

/**
 * The change a drop into a board cell makes: every group of the cell the
 * project is not yet in contributes its value, so a drop into a column and a
 * swimlane can change both fields. Null when the drop changes nothing or a
 * group the project would have to join is not one value it holds, such as a
 * team.
 */
export const dropPatch = (
  project: ProjectRead,
  groups: readonly ProjectGroup[]
): ProjectMove | null => {
  let patch: ProjectMove = {};
  for (const group of groups) {
    if (inGroup(project, group)) continue;
    const change = groupPatch(group, project);
    if (change === null) return null;
    patch = { ...patch, ...change };
  }
  return Object.keys(patch).length === 0 ? null : patch;
};

/**
 * The change a drop into a board cell makes, telling a drop that changes no
 * field, an empty change, from one the cell refuses, null, because a group
 * the project would have to join is not one value it holds, such as a team.
 */
export const cellChange = (
  project: ProjectRead,
  groups: readonly ProjectGroup[]
): ProjectMove | null => {
  if (groups.every((group) => inGroup(project, group))) return {};
  return dropPatch(project, groups);
};

/** One project's new manual position. */
export interface ProjectPlacement {
  projectId: string;
  sort_order: string;
}

/**
 * The manual positions that drop a project at `index` among the other rows
 * of one list or cell, given in the order they are shown. The project lands
 * just after the row shown above the drop point, or first when there is
 * none, so the drop reads right once the rows run in manual order. One key is
 * written when every row ahead of it is placed; otherwise the unplaced rows
 * up to it are placed too, in manual order, since unplaced rows sort last.
 * Null when no key fits.
 */
export const manualPlacements = (
  rows: readonly ProjectRead[],
  movingId: string,
  index: number
): ProjectPlacement[] | null => {
  const shown = rows.filter((project) => project.project_id !== movingId);
  const moving = rows.find((project) => project.project_id === movingId);
  if (moving === undefined) return null;
  const above =
    index > 0 ? shown[Math.min(index, shown.length) - 1] : undefined;
  const manual = [...shown].sort(
    (left, right) =>
      byManual(left, right) || left.name.localeCompare(right.name)
  );
  const at = above === undefined ? 0 : manual.indexOf(above) + 1;
  const moved = [...manual.slice(0, at), moving, ...manual.slice(at)];
  const keyOf = (project: ProjectRead | undefined): string | null =>
    project?.sort_order ?? null;
  try {
    const firstLoose = moved
      .slice(0, at)
      .findIndex((project) => keyOf(project) === null);
    if (firstLoose < 0) {
      const key = orderBetween(keyOf(moved[at - 1]), keyOf(moved[at + 1]));
      return key === keyOf(moving)
        ? []
        : [{ projectId: movingId, sort_order: key }];
    }
    let bound = keyOf(moved[firstLoose - 1]);
    const placements: ProjectPlacement[] = [];
    for (const project of moved.slice(firstLoose, at + 1)) {
      bound = orderBetween(bound, undefined);
      placements.push({ projectId: project.project_id, sort_order: bound });
    }
    return placements;
  } catch {
    return null;
  }
};
