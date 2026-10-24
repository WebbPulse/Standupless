/**
 * The state an issue list or board is drawn from: the filters, the grouping,
 * the ordering, the visible properties and the layout. It lives in the URL so
 * a view can be linked, reloaded and stepped back through, and it round trips
 * to a saved view so "Save view" stores exactly what is on screen.
 *
 * Everything here is pure: parsing, writing, the list query it runs, the
 * saved view it becomes, and the grouping and ordering of the rows it reads.
 */

import { NONE, orderBetween, type IssueListFilters } from '../api/issues';
import type { IssueListSort, OrderedIssueRead } from '../api/issues';
import { viewFilterToQuery } from '../api/views';
import type {
  CompletedWindow,
  SavedViewDisplayCreate,
  SavedViewDisplayRead,
  SavedViewFilter,
  SavedViewLook,
  ViewLayout,
  ViewVisibleProperty,
} from '../api/views';
import type {
  CycleRead,
  IssuePriority,
  IssueRead,
  LabelRead,
  MilestoneRead,
  ProjectRead,
  SlaStatus,
  StatusCategory,
  StatusRead,
  ViewGroupBy,
} from '../types/Api';
import { PRIORITIES, PRIORITY_LABELS } from './issueDisplay';
import { pickableLabels, replacedSiblings } from './labelGroups';
import { completionPercent, progressPercent } from './planningDisplay';
import { personLabel, type Assignable } from './issuePeople';
import { STATUS_CATEGORY_ORDER } from './propertyOptions';
import { liveSlaStatus, SLA_STATUS_LABELS, slaEffectiveDeadline } from './sla';
import { statusLook, TRIAGE_LOOK, type StatusLook } from './statusAppearance';
import {
  shownStatusId,
  TRIAGE_GROUP_KEY,
  TRIAGE_STATUS_ID,
  TRIAGE_STATUS_NAME,
  triageStatusFor,
} from './triageStatus';

/** A property an issue list can be grouped by, or `none`. */
export type GroupField = ViewGroupBy | 'none';

export type { CompletedWindow };

/** The properties a list can be filtered on. */
export type FilterField =
  | 'status'
  | 'assignee'
  | 'creator'
  | 'subscriber'
  | 'priority'
  | 'label'
  | 'estimate'
  | 'team'
  | 'project'
  | 'milestone'
  | 'cycle'
  | 'parent'
  | 'sub_issues'
  | 'content'
  | 'created'
  | 'updated'
  | 'completed'
  | 'due'
  | 'sla'
  | 'blocked'
  | 'blocking'
  | 'relation'
  | 'customer';

/**
 * Whether a filter keeps or excludes the issues matching its values, or, for
 * a date field, whether it keeps the days before or after its one value. A
 * label filter can also keep only the issues carrying `all` of its values.
 */
export type FilterOp = 'is' | 'is_not' | 'all' | 'before' | 'after';

/** How a set of conditions combines: every one must hold, or any one. */
export type FilterMatch = 'all' | 'any';

/**
 * A group of conditions combined on its own, standing as one condition of
 * the whole filter. The bar edits one level of groups, and "match any"
 * wraps the conditions in one more.
 */
export interface FilterGroup {
  match: FilterMatch;
  filters: FilterClause[];
}

/** The most groups a filter carries, the server's own bound. */
export const MAX_FILTER_GROUPS = 10;

/** The fields that hold one yes or no, sent as `true` or `false`. */
export const BOOLEAN_FIELDS: ReadonlySet<FilterField> = new Set([
  'sub_issues',
  'blocked',
  'blocking',
]);

/** The fields that take free text matched against an issue's title and description. */
export const TEXT_FIELDS: ReadonlySet<FilterField> = new Set(['content']);

/** Whether a field takes free text rather than a set of values. */
export const isTextField = (field: FilterField): boolean =>
  TEXT_FIELDS.has(field);

/** Cycle values the server resolves per team when the list runs. */
export const RELATIVE_CYCLES = ['current', 'next', 'previous'] as const;

/**
 * The fields only the server can decide, because the row a client holds does
 * not carry the links they read.
 */
const SERVER_ONLY_FIELDS: ReadonlySet<FilterField> = new Set([
  'subscriber',
  'blocking',
  'relation',
  'customer',
]);

/** The fields filtered by a day bound rather than a set of values. */
export const DATE_FIELDS: ReadonlySet<FilterField> = new Set([
  'created',
  'updated',
  'completed',
  'due',
]);

/** Whether a field takes a day bound rather than a set of values. */
export const isDateField = (field: FilterField): boolean =>
  DATE_FIELDS.has(field);

/** One filter: a property, whether it keeps or excludes, and any of its values. */
export interface FilterClause {
  field: FilterField;
  op: FilterOp;
  values: string[];
}

/** Every completed window, in the order the display menu offers them. */
export const COMPLETED_WINDOWS: CompletedWindow[] = [
  'all',
  'past_week',
  'past_month',
  'none',
];

/** How a completed window reads in the interface. */
export const COMPLETED_WINDOW_LABELS: Record<CompletedWindow, string> = {
  all: 'All',
  past_week: 'Past week',
  past_month: 'Past month',
  none: 'None',
};

/** The days each bounded completed window reaches back. */
const WINDOW_DAYS: Partial<Record<CompletedWindow, number>> = {
  past_week: 7,
  past_month: 30,
};

/** How a completed window sits in the URL's `done` parameter. */
const DONE_PARAMS: Record<CompletedWindow, string> = {
  all: '1',
  past_week: 'week',
  past_month: 'month',
  none: '0',
};

/** Reads the URL's `done` parameter back into a completed window. */
const parseDone = (value: string): CompletedWindow | undefined =>
  COMPLETED_WINDOWS.find((window) => DONE_PARAMS[window] === value);

/** Everything a list or board is drawn from. */
export interface ViewState {
  filters: FilterClause[];
  /** How the top level filters and groups combine. */
  match: FilterMatch;
  /** Groups of filters, each combined on its own and standing as one filter. */
  groups: FilterGroup[];
  /** Free text the list route matches, kept when a saved view carries it. */
  q: string;
  groupBy: GroupField;
  subGroupBy: GroupField;
  ordering: IssueListSort;
  /** True to read the ordering backwards, issues lacking its value still last. */
  reverse: boolean;
  visible: ViewVisibleProperty[];
  layout: ViewLayout;
  showEmpty: boolean;
  /** False to leave out issues that sit under a parent. */
  showSubIssues: boolean;
  /**
   * Which issues in a completed or canceled status show: all of them, those
   * closed in the past week or month, or none.
   */
  completed: CompletedWindow;
  /** True to list archived issues, which every list and board leaves out by default. */
  showArchived: boolean;
}

/**
 * The change that switches a view to `layout`. A board shows its empty
 * columns and needs a grouping to lay them out by, so switching to one turns
 * both on; switching to a list turns empty groups off again.
 */
export const withLayout = (
  state: ViewState,
  layout: ViewLayout
): Partial<ViewState> => ({
  layout,
  showEmpty: layout === 'board',
  ...(layout === 'board' && state.groupBy === 'none'
    ? { groupBy: 'status' as const }
    : {}),
});

/** A status with the team it belongs to, for a list that spans teams. */
export interface ScopedStatus extends StatusRead {
  team_id?: string;
}

/** A label with the team it belongs to, for a list that spans teams. */
export interface ScopedLabel extends LabelRead {
  team_id?: string;
  /** The name of the label group it sits in, so like named labels of two groups stay apart. */
  group_name?: string;
}

/** The lists ids are resolved against when grouping and labelling. */
export interface IssueContext {
  statuses: ScopedStatus[];
  labels: ScopedLabel[];
  people: Assignable[];
  projects: ProjectRead[];
  cycles: CycleRead[];
  /**
   * The milestones of the one project a list is scoped to, in their manual
   * order. Only a project's own list carries them, so grouping and filtering
   * by milestone is offered there and nowhere else.
   */
  milestones?: MilestoneRead[];
  /** The signed in person, listed first and marked in pickers. */
  currentUserId?: string;
  /**
   * The teams a list spans. Only a list over more than one team offers a team
   * filter, since a single team's list already fixes it.
   */
  teams?: { id: string; name: string; key?: string }[];
  /**
   * The issues a list holds that other rows name as their parent, so a
   * grouping by parent issue heads each group with its key and title.
   */
  parents?: ReadonlyMap<string, ParentRef>;
  /**
   * The workspace's customers. Guests may not read customers, so a list
   * offers the customer filter only when this is set.
   */
  customers?: { id: string; name: string }[];
}

/** How a parent issue heads its group: its key and title. */
export interface ParentRef {
  key: string;
  title: string;
}

/** The parents named by the rows of a list, from the rows the list holds. */
export const parentsIn = (
  issues: readonly Pick<IssueRead, 'id' | 'key' | 'title' | 'parent_id'>[]
): Map<string, ParentRef> => {
  const named = new Set(
    issues
      .map((issue) => issue.parent_id)
      .filter((id): id is string => id !== null)
  );
  const parents = new Map<string, ParentRef>();
  for (const issue of issues) {
    if (named.has(issue.id)) {
      parents.set(issue.id, { key: issue.key, title: issue.title });
    }
  }
  return parents;
};

/** The fields a list can be grouped by, in menu order. */
export const GROUP_FIELDS: GroupField[] = [
  'status',
  'assignee',
  'priority',
  'label',
  'project',
  'milestone',
  'cycle',
  'parent',
  'team',
  'sla',
  'none',
];

/**
 * The groupings a board column can be dragged into, because the property is
 * one an issue's own fields hold. A parent, team or SLA column only shows
 * where an issue sits.
 */
export const MOVABLE_GROUP_FIELDS: ReadonlySet<GroupField> = new Set([
  'status',
  'assignee',
  'priority',
  'label',
  'project',
  'milestone',
  'cycle',
]);

/**
 * The fields a list with this context can be grouped or filtered by. A
 * milestone only means something inside one project, so it is left out
 * wherever the context carries no milestones.
 */
export const fieldsFor = <T extends string>(
  fields: readonly T[],
  context: Pick<IssueContext, 'milestones' | 'teams'>
): T[] =>
  fields.filter(
    (field) =>
      (field !== 'milestone' || context.milestones !== undefined) &&
      (field !== 'team' || (context.teams ?? []).length > 1)
  );

/**
 * The fields a list with this context can be filtered by. Unlike grouping, a
 * milestone filter also works across projects, since its choices are read
 * from each project the list knows.
 */
export const filterFieldsFor = (
  context: Pick<IssueContext, 'milestones' | 'teams' | 'projects' | 'customers'>
): FilterField[] =>
  FILTER_FIELDS.filter(
    (field) =>
      (field !== 'milestone' ||
        context.milestones !== undefined ||
        context.projects.length > 0) &&
      (field !== 'team' || (context.teams ?? []).length > 1) &&
      (field !== 'customer' || context.customers !== undefined)
  );

/** How a grouping reads in the interface. */
export const GROUP_LABELS: Record<GroupField, string> = {
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  label: 'Label',
  milestone: 'Milestone',
  project: 'Project',
  cycle: 'Cycle',
  parent: 'Parent issue',
  team: 'Team',
  sla: 'SLA status',
  none: 'No grouping',
};

/** The orderings a list offers, in menu order. */
export const ORDERINGS: IssueListSort[] = [
  'manual',
  'status_asc',
  'priority_desc',
  'updated_desc',
  'created_desc',
  'completed_desc',
  'start_asc',
  'due_asc',
  'estimate_desc',
  'sla_asc',
  'key_asc',
  'customer_requests_desc',
  'customer_revenue_desc',
];

/** How an ordering reads in the interface. */
export const ORDERING_LABELS: Record<IssueListSort, string> = {
  manual: 'Manual',
  priority_desc: 'Priority',
  updated_desc: 'Last updated',
  created_desc: 'Created',
  completed_desc: 'Completed',
  due_asc: 'Due date',
  sla_asc: 'SLA breach',
  key_asc: 'Issue ID',
  status_asc: 'Status',
  start_asc: 'Start date',
  estimate_desc: 'Estimate',
  customer_requests_desc: 'Customer requests',
  customer_revenue_desc: 'Customer revenue',
};

/** The filterable fields, in menu order. */
export const FILTER_FIELDS: FilterField[] = [
  'status',
  'assignee',
  'creator',
  'subscriber',
  'priority',
  'label',
  'estimate',
  'team',
  'project',
  'milestone',
  'cycle',
  'parent',
  'sub_issues',
  'content',
  'created',
  'updated',
  'completed',
  'due',
  'sla',
  'blocked',
  'blocking',
  'relation',
  'customer',
];

/** How a filter field reads in the interface. */
export const FILTER_LABELS: Record<FilterField, string> = {
  status: 'Status',
  assignee: 'Assignee',
  creator: 'Creator',
  subscriber: 'Subscriber',
  priority: 'Priority',
  label: 'Labels',
  estimate: 'Estimate',
  team: 'Team',
  project: 'Project',
  milestone: 'Milestone',
  cycle: 'Cycle',
  parent: 'Parent issue',
  sub_issues: 'Has sub-issues',
  content: 'Content',
  created: 'Created',
  updated: 'Updated',
  completed: 'Completed',
  due: 'Due date',
  sla: 'SLA',
  blocked: 'Blocked',
  blocking: 'Blocking',
  relation: 'Relations',
  customer: 'Customer',
};

/**
 * The fields a filter can only keep, never exclude, because the list route
 * takes no `_not` key for them.
 */
export const KEEP_ONLY_FIELDS: ReadonlySet<FilterField> = new Set([
  'sub_issues',
  'sla',
  'blocked',
  'blocking',
  'relation',
]);

/**
 * The list query key each filter field maps to. A date field's key is the
 * stem its `_before` and `_after` bounds share.
 */
const FILTER_KEYS: Record<FilterField, string> = {
  status: 'status_id',
  assignee: 'assignee_id',
  creator: 'creator_id',
  subscriber: 'subscriber_id',
  priority: 'priority',
  label: 'label_id',
  estimate: 'estimate',
  team: 'team_id_in',
  project: 'project_id',
  milestone: 'project_milestone_id',
  cycle: 'cycle_id',
  parent: 'parent_id',
  sub_issues: 'has_sub_issues',
  content: 'content',
  created: 'created',
  updated: 'updated',
  completed: 'completed',
  due: 'due',
  sla: 'sla_status',
  blocked: 'is_blocked',
  blocking: 'is_blocking',
  relation: 'has_relation',
  customer: 'customer_id',
};

/** The fields whose filter can keep only issues carrying every value. */
export const ALL_OF_FIELDS: ReadonlySet<FilterField> = new Set(['label']);

/** The query key a clause writes, its exclusion or day bound included. */
const clauseKey = (field: FilterField, op: FilterOp): string => {
  if (isDateField(field)) {
    return `${FILTER_KEYS[field]}_${op === 'before' ? 'before' : 'after'}`;
  }
  if (op === 'all') {
    return ALL_OF_FIELDS.has(field)
      ? `${FILTER_KEYS[field]}_all`
      : FILTER_KEYS[field];
  }
  if (op !== 'is_not' || KEEP_ONLY_FIELDS.has(field)) return FILTER_KEYS[field];
  return field === 'team' ? 'team_id_not' : `${FILTER_KEYS[field]}_not`;
};

/** The properties a row can show, in the order they are drawn. */
export const DISPLAY_PROPERTIES: ViewVisibleProperty[] = [
  'priority',
  'id',
  'status',
  'sub_issues',
  'labels',
  'pull_requests',
  'project',
  'milestone',
  'cycle',
  'links',
  'estimate',
  'start_date',
  'due_date',
  'created_at',
  'updated_at',
  'assignee',
];

/** How a display property reads in the interface. */
export const PROPERTY_LABELS: Record<ViewVisibleProperty, string> = {
  id: 'ID',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  labels: 'Labels',
  estimate: 'Estimate',
  start_date: 'Start date',
  due_date: 'Due date',
  project: 'Project',
  cycle: 'Cycle',
  parent: 'Parent',
  sub_issues: 'Sub-issues',
  pull_requests: 'Pull requests',
  milestone: 'Milestone',
  links: 'Links',
  created_at: 'Created',
  updated_at: 'Updated',
};

/** The properties a row shows until someone changes them. */
export const DEFAULT_VISIBLE: ViewVisibleProperty[] = [
  'priority',
  'id',
  'status',
  'sub_issues',
  'labels',
  'pull_requests',
  'project',
  'estimate',
  'due_date',
  'created_at',
  'assignee',
];

/** The state a list opens in with nothing in the URL. */
export const defaultViewState = (layout: ViewLayout = 'list'): ViewState => ({
  filters: [],
  match: 'all',
  groups: [],
  q: '',
  groupBy: 'status',
  subGroupBy: 'none',
  ordering: 'priority_desc',
  reverse: false,
  visible: [...DEFAULT_VISIBLE],
  layout,
  showEmpty: layout === 'board',
  showSubIssues: true,
  completed: 'all',
  showArchived: false,
});

const isGroupField = (value: string | null): value is GroupField =>
  value !== null && (GROUP_FIELDS as string[]).includes(value);

const isOrdering = (value: string | null): value is IssueListSort =>
  value !== null && (ORDERINGS as string[]).includes(value);

const isFilterField = (value: string): value is FilterField =>
  (FILTER_FIELDS as string[]).includes(value);

const isProperty = (value: string): value is ViewVisibleProperty =>
  value in PROPERTY_LABELS;

/** Parses one `f` parameter, `status.is:a,b`, or null when it is malformed. */
const parseClause = (raw: string): FilterClause | null => {
  const colon = raw.indexOf(':');
  if (colon < 0) return null;
  const [field, op] = raw.slice(0, colon).split('.');
  if (field === undefined || !isFilterField(field)) return null;
  const rest = raw.slice(colon + 1);
  const values = isTextField(field)
    ? [rest.trim()].filter((value) => value !== '')
    : rest
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '');
  if (values.length === 0) return null;
  if (isDateField(field)) {
    const day = values[0] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    return { field, op: op === 'before' ? 'before' : 'after', values: [day] };
  }
  if (op === 'all' && ALL_OF_FIELDS.has(field)) {
    return { field, op: 'all', values };
  }
  return {
    field,
    op: op === 'not' && !KEEP_ONLY_FIELDS.has(field) ? 'is_not' : 'is',
    values,
  };
};

const CLAUSE_OPS: Record<FilterOp, string> = {
  is: 'is',
  is_not: 'not',
  all: 'all',
  before: 'before',
  after: 'after',
};

/** Writes one clause as its `f` parameter. */
const writeClause = (clause: FilterClause): string =>
  `${clause.field}.${CLAUSE_OPS[clause.op]}:${clause.values.join(',')}`;

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const sameFilters = (left: FilterClause[], right: FilterClause[]): boolean =>
  sameList(left.map(writeClause), right.map(writeClause));

/**
 * Writes one group as its `g` parameter: its match, then each clause, every
 * part escaped so a value holding the separator stays whole.
 */
const writeGroup = (group: FilterGroup): string =>
  [group.match, ...group.filters.map(writeClause)]
    .map((part) => encodeURIComponent(part))
    .join(';');

/** Parses one `g` parameter, or null when it is malformed. */
const parseGroup = (raw: string): FilterGroup | null => {
  if (raw === '') return null;
  const [head, ...parts] = raw.split(';').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return '';
    }
  });
  if (head !== 'all' && head !== 'any') return null;
  return {
    match: head,
    filters: parts
      .map(parseClause)
      .filter((clause): clause is FilterClause => clause !== null),
  };
};

const sameGroups = (left: FilterGroup[], right: FilterGroup[]): boolean =>
  sameList(left.map(writeGroup), right.map(writeGroup));

/** Whether two states draw the same list. */
export const sameViewState = (left: ViewState, right: ViewState): boolean =>
  sameFilters(left.filters, right.filters) &&
  left.match === right.match &&
  sameGroups(left.groups, right.groups) &&
  left.q === right.q &&
  left.groupBy === right.groupBy &&
  left.subGroupBy === right.subGroupBy &&
  left.ordering === right.ordering &&
  left.reverse === right.reverse &&
  sameList(left.visible, right.visible) &&
  left.layout === right.layout &&
  left.showEmpty === right.showEmpty &&
  left.showSubIssues === right.showSubIssues &&
  left.completed === right.completed &&
  left.showArchived === right.showArchived;

/**
 * Reads the state out of the URL. Every parameter overrides `base`, and one
 * left out keeps the base value, so a saved view's own settings are the base
 * and only what someone changed on top of it sits in the address.
 */
export const parseViewState = (
  params: URLSearchParams,
  base: ViewState
): ViewState => {
  const filters = params.has('f')
    ? params
        .getAll('f')
        .map(parseClause)
        .filter((clause): clause is FilterClause => clause !== null)
    : base.filters;
  const groups = params.has('g')
    ? params
        .getAll('g')
        .map(parseGroup)
        .filter((group): group is FilterGroup => group !== null)
        .slice(0, MAX_FILTER_GROUPS)
    : base.groups;
  const matchParam = params.get('m');
  const layoutParam = params.get('layout');
  const layout: ViewLayout =
    layoutParam === 'board' || layoutParam === 'list'
      ? layoutParam
      : base.layout;
  const group = params.get('group');
  const sub = params.get('sub');
  const order = params.get('order');
  const rev = params.get('rev');
  const props = params.get('props');
  const empty = params.get('empty');
  const subs = params.get('subs');
  const done = params.get('done');
  const archived = params.get('archived');
  const groupBy = isGroupField(group) ? group : base.groupBy;
  const subGroupBy = isGroupField(sub) ? sub : base.subGroupBy;
  return {
    filters,
    match:
      matchParam === 'any' || matchParam === 'all' ? matchParam : base.match,
    groups,
    q: params.get('q') ?? base.q,
    groupBy,
    subGroupBy: subGroupBy === groupBy ? 'none' : subGroupBy,
    ordering: isOrdering(order) ? order : base.ordering,
    reverse: rev === null ? base.reverse : rev === '1',
    visible:
      props === null
        ? base.visible
        : props.split(',').filter((value) => isProperty(value)),
    layout,
    showEmpty:
      empty === null
        ? layout === base.layout
          ? base.showEmpty
          : layout === 'board'
        : empty === '1',
    showSubIssues: subs === null ? base.showSubIssues : subs === '1',
    completed: (done === null ? undefined : parseDone(done)) ?? base.completed,
    showArchived: archived === null ? base.showArchived : archived === '1',
  };
};

/**
 * Writes the state into URL parameters, leaving out everything that matches
 * `base`, and keeping any parameter it does not own, such as `view`.
 */
export const writeViewState = (
  state: ViewState,
  base: ViewState,
  keep?: URLSearchParams
): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of keep?.entries() ?? []) {
    if (
      ![
        'f',
        'm',
        'g',
        'q',
        'group',
        'sub',
        'order',
        'rev',
        'props',
        'layout',
        'empty',
        'subs',
        'done',
        'archived',
      ].includes(key)
    ) {
      params.append(key, value);
    }
  }
  if (!sameFilters(state.filters, base.filters)) {
    if (state.filters.length === 0) params.append('f', '');
    for (const clause of state.filters) params.append('f', writeClause(clause));
  }
  if (state.match !== base.match) params.set('m', state.match);
  if (!sameGroups(state.groups, base.groups)) {
    if (state.groups.length === 0) params.append('g', '');
    for (const group of state.groups) params.append('g', writeGroup(group));
  }
  if (state.q !== base.q) params.set('q', state.q);
  if (state.layout !== base.layout) params.set('layout', state.layout);
  if (state.groupBy !== base.groupBy) params.set('group', state.groupBy);
  if (state.subGroupBy !== base.subGroupBy) params.set('sub', state.subGroupBy);
  if (state.ordering !== base.ordering) params.set('order', state.ordering);
  if (state.reverse !== base.reverse)
    params.set('rev', state.reverse ? '1' : '0');
  if (!sameList(state.visible, base.visible)) {
    params.set('props', state.visible.join(','));
  }
  const emptyDefault =
    state.layout === base.layout ? base.showEmpty : state.layout === 'board';
  if (state.showEmpty !== emptyDefault) {
    params.set('empty', state.showEmpty ? '1' : '0');
  }
  if (state.showSubIssues !== base.showSubIssues) {
    params.set('subs', state.showSubIssues ? '1' : '0');
  }
  if (state.completed !== base.completed) {
    params.set('done', DONE_PARAMS[state.completed]);
  }
  if (state.showArchived !== base.showArchived) {
    params.set('archived', state.showArchived ? '1' : '0');
  }
  return params;
};

/** Adds or removes one value on a field's clause, creating the clause. */
export const toggleFilterValue = (
  filters: FilterClause[],
  field: FilterField,
  value: string
): FilterClause[] => {
  const index = filters.findIndex((clause) => clause.field === field);
  const held = filters[index];
  if (held === undefined) {
    return [...filters, { field, op: 'is', values: [value] }];
  }
  const values = held.values.includes(value)
    ? held.values.filter((item) => item !== value)
    : [...held.values, value];
  if (values.length === 0) return filters.filter((_, at) => at !== index);
  return filters.map((clause, at) =>
    at === index ? { ...clause, values } : clause
  );
};

/**
 * The ids a filter on one value stands for. A status or label is matched by
 * name across teams, as the filter bar offers it, so a chip on one team's
 * "Todo" filters every team's "Todo".
 */
export const filterValuesFor = (
  field: FilterField,
  value: string,
  context: Pick<IssueContext, 'statuses' | 'labels'>
): string[] => {
  if (field === 'status') {
    const status = context.statuses.find((item) => item.id === value);
    if (status === undefined) return [value];
    const key = statusGroupKey(status);
    return [
      ...new Set(
        context.statuses
          .filter((item) => statusGroupKey(item) === key)
          .map((item) => item.id)
      ),
    ];
  }
  if (field === 'label') {
    const label = context.labels.find((item) => item.id === value);
    if (label === undefined) return [value];
    const key = labelGroupKey(label);
    return [
      ...new Set(
        context.labels
          .filter((item) => labelGroupKey(item) === key)
          .map((item) => item.id)
      ),
    ];
  }
  return [value];
};

/** The filters with one field narrowed to exactly these values, as a chip click asks. */
export const narrowFilters = (
  filters: FilterClause[],
  field: FilterField,
  values: string[]
): FilterClause[] => [
  ...filters.filter((clause) => clause.field !== field),
  { field, op: 'is', values },
];

/** The values an issue holds for a filter field, `none` standing for unset. */
const issueFilterValues = (issue: IssueRead, field: FilterField): string[] => {
  switch (field) {
    case 'status':
      return [shownStatusId(issue)];
    case 'assignee':
      return [issue.assignee_id ?? NONE];
    case 'creator':
      return [issue.created_by];
    case 'parent':
      return [issue.parent_id ?? NONE];
    case 'sub_issues':
      return [String(issue.progress.total > 0)];
    case 'completed':
      return issue.completed_at === null || issue.completed_at === undefined
        ? []
        : [issue.completed_at.slice(0, 10)];
    case 'team':
      return [issue.team_id];
    case 'priority':
      return [issue.priority];
    case 'label':
      return issue.label_ids.length === 0 ? [NONE] : issue.label_ids;
    case 'created':
      return [issue.created_at.slice(0, 10)];
    case 'updated':
      return [issue.updated_at.slice(0, 10)];
    case 'due':
      return issue.due_date === null ? [] : [issue.due_date.slice(0, 10)];
    case 'estimate':
      return [issue.estimate ?? NONE];
    case 'project':
      return [issue.project_id ?? NONE];
    case 'milestone':
      return [issue.project_milestone_id ?? NONE];
    case 'cycle':
      return [issue.cycle_id ?? NONE];
    case 'sla':
      return [liveSlaStatus(issue)];
    case 'blocked':
      return [String((issue.blocked_by_open_count ?? 0) > 0)];
    case 'subscriber':
    case 'content':
    case 'blocking':
    case 'relation':
    case 'customer':
      return [];
  }
};

/** Whether a clause needs a read the client cannot make, so only the server applies it. */
const decidedByServer = (clause: FilterClause): boolean =>
  SERVER_ONLY_FIELDS.has(clause.field) ||
  (clause.field === 'cycle' &&
    clause.values.some((value) =>
      (RELATIVE_CYCLES as readonly string[]).includes(value)
    ));

/** Whether an issue's title or description holds a piece of text, ignoring case. */
const contentHolds = (issue: IssueRead, text: string): boolean =>
  `${issue.title}\n${issue.body ?? ''}`
    .toLowerCase()
    .includes(text.trim().toLowerCase());

/** Whether one clause holds for an issue, true for a clause only the server decides. */
const clauseHolds = (issue: IssueRead, clause: FilterClause): boolean => {
  if (decidedByServer(clause)) return true;
  if (isTextField(clause.field)) {
    const hit = contentHolds(issue, clause.values[0] ?? '');
    return clause.op === 'is_not' ? !hit : hit;
  }
  const held = issueFilterValues(issue, clause.field);
  if (clause.op === 'before' || clause.op === 'after') {
    const bound = clause.values[0] ?? '';
    const day = held[0];
    if (day === undefined) return false;
    return clause.op === 'before' ? day < bound : day > bound;
  }
  if (clause.op === 'all') {
    return clause.values.every((value) => held.includes(value));
  }
  const hit = held.some((value) => clause.values.includes(value));
  return clause.op === 'is' ? hit : !hit;
};

/** Whether a set of conditions holds under its match; an empty `any` set holds. */
const combined = (results: boolean[], match: FilterMatch): boolean =>
  match === 'any'
    ? results.length === 0 || results.some(Boolean)
    : results.every(Boolean);

/**
 * Whether an issue passes the filters, for a list filtered on the client. The
 * top level clauses and each group combine under `match`, every clause by
 * default, and each group combines its own clauses under its own match.
 */
export const matchesFilters = (
  issue: IssueRead,
  filters: FilterClause[],
  match: FilterMatch = 'all',
  groups: readonly FilterGroup[] = []
): boolean =>
  combined(
    [
      ...filters.map((clause) => clauseHolds(issue, clause)),
      ...groups.map((group) =>
        combined(
          group.filters.map((clause) => clauseHolds(issue, clause)),
          group.match
        )
      ),
    ],
    match
  );

/** The query keys a list of clauses writes, each key's values merged. */
const clauseQuery = (
  filters: readonly FilterClause[]
): Record<string, string | string[]> => {
  const query: Record<string, string | string[]> = {};
  for (const clause of filters) {
    const key = clauseKey(clause.field, clause.op);
    if (isDateField(clause.field) || isTextField(clause.field)) {
      const value = clause.values[0];
      if (value !== undefined) query[key] = value;
      continue;
    }
    if (BOOLEAN_FIELDS.has(clause.field)) {
      const [only, ...rest] = [...new Set(clause.values)];
      if (only !== undefined && rest.length === 0) query[key] = only;
      continue;
    }
    const held = query[key];
    const merged = [
      ...(held === undefined ? [] : Array.isArray(held) ? held : [held]),
      ...clause.values,
    ];
    query[key] = [...new Set(merged)];
  }
  return query;
};

/** One stored condition group: its clauses' keys, its match when that is `any`, and any groups inside it. */
export interface SavedFilterGroup {
  [key: string]: string | string[] | SavedFilterGroup[];
}

/** The groups a state sends, each as the keys its clauses write; empty groups drop out. */
export const groupQuery = (
  groups: readonly FilterGroup[]
): SavedFilterGroup[] =>
  groups
    .filter((group) => group.filters.length > 0)
    .map((group) => ({
      ...(group.match === 'any' ? { match: 'any' } : {}),
      ...clauseQuery(group.filters),
    }));

/**
 * The person's own conditions as the server takes them. Every list runs under
 * a fixed scope, such as a team, a project or hiding completed issues, that
 * must always hold, so "match any" never goes on the top of the filter, where
 * it would let an issue in through the scope. The conditions are wrapped in
 * one `any` group instead, the person's groups nested inside it.
 */
const wireConditions = (
  state: Pick<ViewState, 'filters' | 'match' | 'groups'>
): { flat: Record<string, string | string[]>; groups: SavedFilterGroup[] } => {
  const groups = groupQuery(state.groups);
  if (
    state.match === 'all' ||
    (state.filters.length === 0 && groups.length === 0)
  ) {
    return { flat: clauseQuery(state.filters), groups };
  }
  return {
    flat: {},
    groups: [
      {
        match: 'any',
        ...clauseQuery(state.filters),
        ...(groups.length > 0 ? { groups } : {}),
      },
    ],
  };
};

/** The list query a state runs, on top of the fixed scope such as a team. */
export const viewStateQuery = (
  state: ViewState,
  scope: IssueListFilters = {}
): IssueListFilters => {
  const { flat, groups } = wireConditions(state);
  const query: Record<string, string | string[]> = { ...flat };
  if (groups.length > 0) query['groups'] = JSON.stringify(groups);
  return {
    ...scope,
    ...(query as IssueListFilters),
    ...(state.q === '' ? {} : { q: state.q }),
    ...(state.showArchived ? { include_archived: true } : {}),
    sort: state.ordering,
    ...(state.reverse ? { reverse: true } : {}),
  };
};

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** The clauses a stored filter, or one of its groups, holds. */
const filterClauses = (filter: Record<string, unknown>): FilterClause[] => {
  const read = (key: string): string[] => {
    const value = filter[key];
    if (typeof value === 'string') return asList(value);
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
    return [];
  };
  const filters: FilterClause[] = [];
  for (const field of FILTER_FIELDS) {
    if (isDateField(field)) {
      for (const op of ['after', 'before'] as const) {
        const day = read(clauseKey(field, op))[0];
        if (day !== undefined && day !== '') {
          filters.push({ field, op, values: [day.slice(0, 10)] });
        }
      }
      continue;
    }
    const kept = read(clauseKey(field, 'is'));
    const all = ALL_OF_FIELDS.has(field) ? read(clauseKey(field, 'all')) : [];
    const dropped = KEEP_ONLY_FIELDS.has(field)
      ? []
      : read(clauseKey(field, 'is_not'));
    if (kept.length > 0) filters.push({ field, op: 'is', values: kept });
    if (all.length > 0) filters.push({ field, op: 'all', values: all });
    if (dropped.length > 0) {
      filters.push({ field, op: 'is_not', values: dropped });
    }
  }
  return filters;
};

/** The groups a stored filter carries, as a list or its JSON text; anything else reads as none. */
const parsedGroups = (value: unknown): Record<string, unknown>[] => {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
  );
};

/** The stored groups as the bar edits them, each one level of clauses under its own match. */
const storedGroups = (value: unknown): FilterGroup[] =>
  parsedGroups(value)
    .slice(0, MAX_FILTER_GROUPS)
    .map((item) => ({
      match: item['match'] === 'any' ? 'any' : 'all',
      filters: filterClauses(item),
    }));

/**
 * A stored filter's own conditions as the bar edits them. A filter saved with
 * "match any" holds its conditions in one `any` group, as `wireConditions`
 * writes it, and reads back unwrapped. A filter whose top level says `any`,
 * as an agent may write one, reads as it is.
 */
const storedConditions = (
  filter: Record<string, unknown>
): Pick<ViewState, 'filters' | 'match' | 'groups'> => {
  const filters = filterClauses(filter);
  const raw = parsedGroups(filter['groups']);
  const only = raw.length === 1 ? raw[0] : undefined;
  if (
    filter['match'] !== 'any' &&
    filters.length === 0 &&
    only !== undefined &&
    only['match'] === 'any'
  ) {
    return {
      filters: filterClauses(only),
      match: 'any',
      groups: storedGroups(only['groups']),
    };
  }
  return {
    filters,
    match: filter['match'] === 'any' ? 'any' : 'all',
    groups: storedGroups(raw),
  };
};

/** Reads a saved view back into the state it was saved from. */
export const viewToState = (view: SavedViewDisplayRead): ViewState => {
  const filter = view.filter as Record<string, unknown>;
  const conditions = storedConditions(filter);
  const layout: ViewLayout =
    view.layout === 'board' || view.layout === 'list'
      ? view.layout
      : view.kind === 'board'
        ? 'board'
        : 'list';
  const groupBy: GroupField = view.group_by ?? 'none';
  const sub: GroupField = view.sub_group_by ?? 'none';
  const ordering = view.ordering ?? view.sort;
  return {
    ...conditions,
    q: typeof filter['q'] === 'string' ? filter['q'] : '',
    groupBy,
    subGroupBy: sub === groupBy ? 'none' : sub,
    ordering: isOrdering(ordering) ? ordering : 'priority_desc',
    reverse: view.ordering_reversed === true,
    visible: view.visible_properties ?? [...DEFAULT_VISIBLE],
    layout,
    showEmpty: layout === 'board',
    showSubIssues: view.show_sub_issues !== false,
    completed:
      view.completed_window ?? (view.show_completed === false ? 'none' : 'all'),
    showArchived: view.show_archived === true,
  };
};

/**
 * The stored filter keys a view carries that the filter bar does not edit:
 * its team and a status category. They are the fixed scope the view runs
 * under, kept as they are when the view is updated.
 */
const SCOPE_KEYS = [
  'team_id',
  'status_category',
  'status_category_not',
] as const;

/** The fixed scope of a stored filter, as the list query it adds. */
export const viewScope = (filter: SavedViewFilter): IssueListFilters => {
  const query = viewFilterToQuery(filter) as Record<string, unknown>;
  const scope: Record<string, unknown> = {};
  for (const key of SCOPE_KEYS) {
    if (query[key] !== undefined) scope[key] = query[key];
  }
  return scope;
};

/** The stored filter a state saves as, on top of the scope it runs under. */
export const stateToViewFilter = (
  state: ViewState,
  scope: IssueListFilters = {}
): SavedViewFilter => {
  const query = viewStateQuery(state, scope) as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (
      key !== 'sort' &&
      key !== 'reverse' &&
      key !== 'cursor' &&
      key !== 'limit' &&
      key !== 'include_archived' &&
      key !== 'archived_only' &&
      key !== 'include_sub_teams' &&
      key !== 'groups'
    )
      filter[key] = value;
  }
  const { groups } = wireConditions(state);
  if (groups.length > 0) filter['groups'] = groups;
  return filter;
};

/** The display settings a state saves as. */
export const stateToViewDisplay = (
  state: ViewState
): Pick<
  SavedViewDisplayCreate,
  | 'sort'
  | 'ordering'
  | 'ordering_reversed'
  | 'group_by'
  | 'sub_group_by'
  | 'visible_properties'
  | 'layout'
  | 'show_sub_issues'
  | 'show_completed'
  | 'completed_window'
  | 'show_archived'
> => ({
  sort: state.ordering,
  ordering: state.ordering,
  ordering_reversed: state.reverse,
  group_by: state.groupBy === 'none' ? null : state.groupBy,
  sub_group_by:
    state.subGroupBy === 'none' || state.subGroupBy === state.groupBy
      ? null
      : state.subGroupBy,
  visible_properties: state.visible,
  layout: state.layout,
  show_sub_issues: state.showSubIssues,
  show_completed: state.completed !== 'none',
  completed_window: state.completed,
  show_archived: state.showArchived,
});

/** How a new view is filed and how it looks, beyond its filters and display. */
export interface ViewBodyOptions {
  /** True with no `shareWith` to share the view with the whole workspace. */
  shared?: boolean;
  look?: SavedViewLook;
}

/**
 * The saved view body a state creates. `shareWith` makes it a team view that
 * everyone in that team sees; `shared` with no team makes it a workspace
 * view; with neither the view is the caller's own.
 */
export const stateToViewBody = (
  state: ViewState,
  name: string,
  scope: IssueListFilters = {},
  shareWith?: string,
  options: ViewBodyOptions = {}
): SavedViewDisplayCreate => ({
  name,
  kind: state.layout,
  filter: stateToViewFilter(state, scope),
  ...stateToViewDisplay(state),
  ...(shareWith === undefined ? {} : { team_id: shareWith }),
  ...(shareWith === undefined && options.shared === true
    ? { shared: true }
    : {}),
  ...(options.look ?? {}),
});

/**
 * The key statuses are grouped under, shared by like named statuses across
 * teams. The synthetic Triage status has a key of its own, apart from any real
 * status a team happens to name Triage.
 */
export const statusGroupKey = (status: StatusRead): string =>
  status.id === TRIAGE_STATUS_ID
    ? TRIAGE_GROUP_KEY
    : `${status.category}:${status.name.trim().toLowerCase()}`;

/** The key labels are grouped under, shared by like named labels across teams, and by their group's name. */
export const labelGroupKey = (label: ScopedLabel): string =>
  (label.group_name === undefined
    ? label.name
    : `${label.group_name}/${label.name}`
  )
    .trim()
    .toLowerCase();

/** How a label reads in a merged list: `Group/Label` inside a group. */
export const scopedLabelName = (label: ScopedLabel): string =>
  label.group_name === undefined
    ? label.name
    : `${label.group_name}/${label.name}`;

/** One group of rows and how its header reads. */
export interface IssueGroup {
  key: string;
  field: GroupField;
  label: string;
  /** The status category, for a status group's glyph. */
  category?: StatusCategory;
  /** The first status's resolved icon, color and fill, for its glyph. */
  statusLook?: StatusLook;
  /** The priority, for a priority group's glyph. */
  priority?: IssuePriority;
  /** The label colour, for a label group's dot. */
  color?: string;
  /** The person's name, for an assignee group's avatar. */
  person?: string;
  /** The milestone's rolled up progress as a whole percent, for its header. */
  progress?: number;
  issues: OrderedIssueRead[];
}

/**
 * Whether a closed issue falls inside a completed window. A bounded window
 * measures from when the issue was completed, or from its last change when it
 * was canceled or closed before that was stamped.
 */
const insideWindow = (
  issue: OrderedIssueRead,
  window: CompletedWindow,
  now: number
): boolean => {
  if (window === 'all') return true;
  const days = WINDOW_DAYS[window];
  if (days === undefined) return false;
  const closed = Date.parse(issue.completed_at ?? issue.updated_at);
  if (Number.isNaN(closed)) return true;
  return now - closed <= days * 24 * 60 * 60 * 1000;
};

/**
 * The issues a state shows out of what the query returned: sub-issues drop
 * out when the display options hide them, and closed issues outside the
 * completed window do too.
 */
export const shownIssues = <T extends OrderedIssueRead>(
  issues: T[],
  state: Pick<ViewState, 'showSubIssues' | 'completed'>,
  context: IssueContext,
  now: number = Date.now()
): T[] => {
  if (state.showSubIssues && state.completed === 'all') return issues;
  return issues.filter((issue) => {
    if (!state.showSubIssues && issue.parent_id !== null) return false;
    if (state.completed !== 'all') {
      const category = statusOf(issue, context)?.category;
      if (
        (category === 'completed' || category === 'cancelled') &&
        !insideWindow(issue, state.completed, now)
      )
        return false;
    }
    return true;
  });
};

/** The folded-set key that hides a board column. */
export const hiddenColumnKey = (column: string): string => `column/${column}`;

/** The ids an issue is resolved by: its own team and the rows it points at. */
export type IssueRefs = Pick<
  OrderedIssueRead,
  'team_id' | 'status_id' | 'label_ids' | 'in_triage'
>;

/**
 * One lookup keyed by row id, holding the issue's own team copy of a row that
 * several teams list, or the first copy when its team lists none.
 */
const lookupFor = <T extends { id: string; team_id?: string }>(
  rows: readonly T[],
  teamId: string
): Map<string, T> => {
  const byId = new Map<string, T>();
  for (const row of rows) {
    const held = byId.get(row.id);
    if (
      held === undefined ||
      (held.team_id !== teamId && row.team_id === teamId)
    ) {
      byId.set(row.id, row);
    }
  }
  return byId;
};

/**
 * The status an issue shows under, from a list that may span teams. A workspace
 * status appears once per team in such a list, and the issue's own team copy
 * carries that team's name for it. An issue waiting in triage shows under the
 * synthetic Triage status, its real one hidden.
 */
export const statusForIssue = <T extends ScopedStatus>(
  issue: IssueRefs,
  statuses: readonly T[]
): T | ScopedStatus | undefined =>
  issue.in_triage === true
    ? triageStatusFor(issue.team_id)
    : lookupFor(statuses, issue.team_id).get(issue.status_id);

/**
 * The labels an issue carries, each id once, in the order the lists name
 * them. A workspace label every team inherits is one id listed per team, and
 * resolves to the issue's own team copy, so a team override reads as that
 * team names it.
 */
export const labelsForIssue = <T extends ScopedLabel>(
  issue: IssueRefs,
  labels: readonly T[]
): T[] => {
  const carried = new Set(issue.label_ids);
  return [...lookupFor(labels, issue.team_id).values()].filter((label) =>
    carried.has(label.id)
  );
};

/** The status an issue sits in, resolved against its own team when known. */
export const statusOf = (
  issue: OrderedIssueRead,
  context: IssueContext
): ScopedStatus | undefined => statusForIssue(issue, context.statuses);

/** The labels an issue carries, each once, as its own team names them. */
export const labelsOf = (
  issue: OrderedIssueRead,
  context: IssueContext
): ScopedLabel[] => labelsForIssue(issue, context.labels);

/**
 * The milestone an issue sits under, or undefined when it has none. A
 * milestone deleted a moment ago can still be on the issue until the server
 * clears it, and reads as none rather than as a stage that is gone.
 */
export const milestoneOf = (
  issue: OrderedIssueRead,
  context: IssueContext
): MilestoneRead | undefined => {
  const id = issue.project_milestone_id ?? null;
  if (id === null) return undefined;
  return context.milestones?.find(
    (milestone) =>
      milestone.milestone_id === id && milestone.project_id === issue.project_id
  );
};

/** The group keys one issue falls under. A label group may hold it several times. */
export const groupKeysOf = (
  issue: OrderedIssueRead,
  field: GroupField,
  context: IssueContext
): string[] => {
  switch (field) {
    case 'status': {
      const status = statusOf(issue, context);
      return [status === undefined ? NONE : statusGroupKey(status)];
    }
    case 'assignee':
      return [issue.assignee_id ?? NONE];
    case 'priority':
      return [issue.priority];
    case 'label': {
      const keys = [...new Set(labelsOf(issue, context).map(labelGroupKey))];
      return keys.length === 0 ? [NONE] : keys;
    }
    case 'milestone':
      return [milestoneOf(issue, context)?.milestone_id ?? NONE];
    case 'project':
      return [issue.project_id ?? NONE];
    case 'cycle':
      return [issue.cycle_id ?? NONE];
    case 'parent':
      return [issue.parent_id ?? NONE];
    case 'team':
      return [issue.team_id];
    case 'sla':
      return [liveSlaStatus(issue)];
    default:
      return ['all'];
  }
};

/** The SLA statuses in the order a grouping reads them: the most urgent first. */
export const SLA_GROUP_ORDER: readonly SlaStatus[] = [
  'breached',
  'at_risk',
  'on_track',
  'none',
];

const CLOSED_PROJECT_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'canceled',
]);

const spansTeams = (context: IssueContext): boolean =>
  (context.teams?.length ?? 0) > 1;

/** How a cycle heads its group, led by its team's key when a list spans teams. */
const cycleLabel = (cycle: CycleRead, context: IssueContext): string => {
  if (!spansTeams(context)) return cycle.name;
  const team = context.teams?.find((entry) => entry.id === cycle.team_id);
  const prefix = team?.key ?? team?.name;
  return prefix === undefined ? cycle.name : `${prefix} ${cycle.name}`;
};

/** How a parent issue heads its group: its key and title. */
const parentLabel = (parent: ParentRef): string =>
  `${parent.key} ${parent.title}`;

/**
 * The header a row's group takes when the field's shells do not hold it, such
 * as a closed project, a finished cycle or a parent outside the list.
 */
const fallbackLabel = (
  field: GroupField,
  key: string,
  context: IssueContext
): string => {
  switch (field) {
    case 'assignee':
      return 'Unknown person';
    case 'status':
      return 'Unknown status';
    case 'project':
      return (
        context.projects.find((project) => project.project_id === key)?.name ??
        'Unknown project'
      );
    case 'cycle': {
      const cycle = context.cycles.find((entry) => entry.cycle_id === key);
      return cycle === undefined ? 'Unknown cycle' : cycleLabel(cycle, context);
    }
    case 'parent': {
      const parent = context.parents?.get(key);
      return parent === undefined ? 'Unknown parent' : parentLabel(parent);
    }
    case 'team':
      return (
        context.teams?.find((team) => team.id === key)?.name ?? 'Unknown team'
      );
    default:
      return key;
  }
};

/** Every group a field can have, in display order, before rows are placed. */
const groupShells = (
  field: GroupField,
  context: IssueContext
): Omit<IssueGroup, 'issues'>[] => {
  switch (field) {
    case 'status': {
      const seen = new Set<string>();
      const shells: Omit<IssueGroup, 'issues'>[] = [];
      const ordered = [...context.statuses].sort(
        (left, right) =>
          STATUS_CATEGORY_ORDER.indexOf(left.category) -
            STATUS_CATEGORY_ORDER.indexOf(right.category) ||
          left.position - right.position
      );
      for (const status of ordered) {
        const key = statusGroupKey(status);
        if (seen.has(key)) continue;
        seen.add(key);
        shells.push({
          key,
          field,
          label: status.name,
          category: status.category,
          statusLook: statusLook(status, context.statuses),
        });
      }
      return shells;
    }
    case 'assignee': {
      const me = context.people.find(
        (person) => person.user_id === context.currentUserId
      );
      const others = context.people
        .filter((person) => person !== me)
        .sort((left, right) =>
          personLabel(left).localeCompare(personLabel(right))
        );
      return [
        { key: NONE, field, label: 'No assignee' },
        ...(me === undefined ? [] : [me]).concat(others).map((person) => ({
          key: person.user_id,
          field,
          label: personLabel(person),
          person: personLabel(person),
        })),
      ];
    }
    case 'priority':
      return PRIORITIES.map((priority) => ({
        key: priority,
        field,
        label: PRIORITY_LABELS[priority],
        priority,
      }));
    case 'label': {
      const seen = new Set<string>();
      const shells: Omit<IssueGroup, 'issues'>[] = [
        { key: NONE, field, label: 'No label' },
      ];
      for (const label of pickableLabels(context.labels).sort((left, right) =>
        scopedLabelName(left).localeCompare(scopedLabelName(right))
      )) {
        const key = labelGroupKey(label);
        if (seen.has(key)) continue;
        seen.add(key);
        shells.push({
          key,
          field,
          label: scopedLabelName(label),
          color: label.color,
        });
      }
      return shells;
    }
    case 'milestone':
      return [
        ...[...(context.milestones ?? [])]
          .sort((left, right) =>
            left.sort_order < right.sort_order
              ? -1
              : left.sort_order > right.sort_order
                ? 1
                : 0
          )
          .map((milestone) => ({
            key: milestone.milestone_id,
            field,
            label: milestone.name,
            progress: progressPercent(milestone),
          })),
        { key: NONE, field, label: 'No milestone' },
      ];
    case 'project':
      return [
        ...context.projects
          .filter((project) => !CLOSED_PROJECT_STATUSES.has(project.status))
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((project) => ({
            key: project.project_id,
            field,
            label: project.name,
            progress: progressPercent(project),
          })),
        { key: NONE, field, label: 'No project' },
      ];
    case 'cycle':
      return [
        ...context.cycles
          .filter(
            (cycle) =>
              !cycle.cancelled &&
              cycle.status !== 'cancelled' &&
              cycle.status !== 'completed'
          )
          .sort(
            (left, right) =>
              left.start_date.localeCompare(right.start_date) ||
              cycleLabel(left, context).localeCompare(
                cycleLabel(right, context)
              )
          )
          .map((cycle) => ({
            key: cycle.cycle_id,
            field,
            label: cycleLabel(cycle, context),
            progress: completionPercent(cycle.counts),
          })),
        { key: NONE, field, label: 'No cycle' },
      ];
    case 'parent':
      return [{ key: NONE, field, label: 'No parent' }];
    case 'team':
      return (context.teams ?? []).map((team) => ({
        key: team.id,
        field,
        label: team.name,
      }));
    case 'sla':
      return SLA_GROUP_ORDER.map((status) => ({
        key: status,
        field,
        label: SLA_STATUS_LABELS[status],
      }));
    default:
      return [{ key: 'all', field, label: 'All issues' }];
  }
};

/**
 * Splits rows into groups in display order. Rows keep their order inside a
 * group. A group with no rows is kept only when `showEmpty` is set, and a
 * row whose value is missing from the lists, such as someone who has left
 * the team, gets a group of its own rather than disappearing. Issues waiting
 * in triage lead a status grouping under a Triage group of their own.
 */
export const groupIssues = (
  issues: OrderedIssueRead[],
  field: GroupField,
  context: IssueContext,
  showEmpty: boolean
): IssueGroup[] => {
  const groups = groupShells(field, context).map((shell) => ({
    ...shell,
    issues: [] as OrderedIssueRead[],
  }));
  const byKey = new Map(groups.map((group) => [group.key, group]));
  for (const issue of issues) {
    for (const key of groupKeysOf(issue, field, context)) {
      let group = byKey.get(key);
      if (
        group === undefined &&
        field === 'status' &&
        key === TRIAGE_GROUP_KEY
      ) {
        group = {
          key,
          field,
          label: TRIAGE_STATUS_NAME,
          category: 'backlog',
          statusLook: TRIAGE_LOOK,
          issues: [],
        };
        byKey.set(key, group);
        groups.unshift(group);
      }
      if (group === undefined) {
        group = {
          key,
          field,
          label: fallbackLabel(field, key, context),
          ...(field === 'assignee' ? { person: '?' } : {}),
          issues: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.issues.push(issue);
    }
  }
  if (field === 'parent') {
    const index = groups.findIndex((group) => group.key === NONE);
    if (index !== -1) groups.push(...groups.splice(index, 1));
  }
  return showEmpty || field === 'none'
    ? groups
    : groups.filter((group) => group.issues.length > 0);
};

/**
 * When an issue's SLA breaches, in milliseconds, or null when it has no
 * timer, so the SLA ordering can put those last. A paused timer sorts by the
 * deadline it would have if it resumed now.
 */
const slaDeadline = (issue: OrderedIssueRead): number | null => {
  if (issue.sla_status === 'none' || !issue.sla_breaches_at) return null;
  return slaEffectiveDeadline(issue);
};

const PRIORITY_RANK: Record<IssuePriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const TSHIRT_POINTS: Record<string, number> = {
  XS: 1,
  S: 2,
  M: 3,
  L: 5,
  XL: 8,
  XXL: 13,
  XXXL: 21,
};

/**
 * An estimate as whole points, the way the server weighs it: a t-shirt size
 * on its ladder, a number as itself, anything else as zero.
 */
export const estimatePoints = (estimate: string | null): number => {
  if (estimate === null) return 0;
  const text = estimate.trim();
  const size = TSHIRT_POINTS[text.toUpperCase()];
  if (size !== undefined) return size;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
};

const isUnestimated = (estimate: string | null): boolean =>
  estimate === null || estimate.trim() === '';

/**
 * Where an issue's status sits on its board: triage first, then category and
 * position, and a status missing from the lists last.
 */
const statusRank = (
  issue: OrderedIssueRead,
  context: IssueContext | undefined
): [number, number] => {
  if (issue.in_triage === true) return [-1, 0];
  const status =
    context === undefined
      ? undefined
      : context.statuses.find(
          (entry) =>
            entry.id === issue.status_id &&
            (entry.team_id === undefined || entry.team_id === issue.team_id)
        );
  if (status === undefined) return [STATUS_CATEGORY_ORDER.length, 0];
  const category = STATUS_CATEGORY_ORDER.indexOf(status.category);
  return [
    category === -1 ? STATUS_CATEGORY_ORDER.length : category,
    status.position,
  ];
};

/** Whether an issue lacks the value an ordering reads, so it sorts last either way. */
const lacksValue = (
  issue: OrderedIssueRead,
  ordering: IssueListSort
): boolean => {
  switch (ordering) {
    case 'manual':
      return (issue.sort_order ?? null) === null;
    case 'due_asc':
      return issue.due_date === null;
    case 'sla_asc':
      return slaDeadline(issue) === null;
    case 'start_asc':
      return (issue.start_date ?? null) === null;
    case 'estimate_desc':
      return isUnestimated(issue.estimate);
    case 'completed_desc':
      return (issue.completed_at ?? null) === null;
    default:
      return false;
  }
};

/** Options for ordering rows beyond the ordering itself. */
export interface SortOptions {
  /** Read the ordering backwards, rows lacking its value still last. */
  reverse?: boolean;
  /** The statuses the status ordering ranks rows by. */
  context?: IssueContext;
}

/**
 * Orders rows the way the list route does, so an optimistic change lands in
 * its new place at once rather than on the next read. Priority ties go
 * to the newest created, then the higher id; status ties go to the higher
 * priority; other ties keep their incoming order. Reversing flips the
 * comparison but keeps rows lacking the sorted value last, as the server does.
 */
export const sortIssues = (
  issues: OrderedIssueRead[],
  ordering: IssueListSort,
  options: SortOptions = {}
): OrderedIssueRead[] => {
  const direction = options.reverse === true ? -1 : 1;
  const indexed = issues.map((issue, index) => ({ issue, index }));
  const compare = (left: OrderedIssueRead, right: OrderedIssueRead): number => {
    switch (ordering) {
      case 'manual': {
        const a = left.sort_order ?? '';
        const b = right.sort_order ?? '';
        return a < b ? -1 : a > b ? 1 : 0;
      }
      case 'priority_desc':
        return (
          PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
          right.created_at.localeCompare(left.created_at) ||
          right.id.localeCompare(left.id)
        );
      case 'updated_desc':
        return right.updated_at.localeCompare(left.updated_at);
      case 'created_desc':
        return right.created_at.localeCompare(left.created_at);
      case 'completed_desc':
        return (
          (right.completed_at ?? '').localeCompare(left.completed_at ?? '') ||
          right.id.localeCompare(left.id)
        );
      case 'due_asc':
        return (left.due_date ?? '').localeCompare(right.due_date ?? '');
      case 'sla_asc':
        return (slaDeadline(left) ?? 0) - (slaDeadline(right) ?? 0);
      case 'start_asc':
        return (left.start_date ?? '').localeCompare(right.start_date ?? '');
      case 'estimate_desc':
        return (
          estimatePoints(right.estimate) - estimatePoints(left.estimate) ||
          right.id.localeCompare(left.id)
        );
      case 'status_asc': {
        const [leftCategory, leftPosition] = statusRank(left, options.context);
        const [rightCategory, rightPosition] = statusRank(
          right,
          options.context
        );
        return (
          leftCategory - rightCategory ||
          leftPosition - rightPosition ||
          PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
          left.id.localeCompare(right.id)
        );
      }
      case 'key_asc':
        return (
          left.key
            .split('-')[0]
            ?.localeCompare(right.key.split('-')[0] ?? '') ||
          left.number - right.number
        );
      default:
        return 0;
    }
  };
  const ranked = (left: OrderedIssueRead, right: OrderedIssueRead): number => {
    const leftMissing = lacksValue(left, ordering);
    const rightMissing = lacksValue(right, ordering);
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (leftMissing) return 0;
    return direction * compare(left, right);
  };
  return indexed
    .sort(
      (left, right) =>
        ranked(left.issue, right.issue) || left.index - right.index
    )
    .map((entry) => entry.issue);
};

/** A change to one or many issues, in the shape a bulk patch takes. */
export interface IssueChange {
  status_id?: string;
  priority?: IssuePriority;
  assignee_id?: string | null;
  estimate?: string | null;
  add_label_ids?: string[];
  remove_label_ids?: string[];
  project_id?: string | null;
  project_milestone_id?: string | null;
  cycle_id?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  parent_id?: string | null;
  sort_order?: string;
}

/**
 * Lays a change over an issue, adding and removing labels rather than
 * replacing them. Triage sends the issue there with its real status kept, and
 * a real status takes an issue out of triage, as the server does.
 */
export const applyChange = (
  issue: OrderedIssueRead,
  change: IssueChange
): OrderedIssueRead => {
  const { add_label_ids, remove_label_ids, ...rest } = change;
  const { status_id: statusId, ...others } = rest;
  const fields =
    statusId === undefined
      ? others
      : statusId === TRIAGE_STATUS_ID
        ? { ...others, in_triage: true }
        : issue.in_triage === true
          ? { ...others, status_id: statusId, in_triage: false }
          : { ...others, status_id: statusId };
  let labelIds = issue.label_ids;
  if (remove_label_ids !== undefined) {
    labelIds = labelIds.filter((id) => !remove_label_ids.includes(id));
  }
  if (add_label_ids !== undefined) {
    labelIds = [
      ...labelIds,
      ...add_label_ids.filter((id) => !labelIds.includes(id)),
    ];
  }
  const cleared =
    fields.project_id !== undefined &&
    fields.project_id !== issue.project_id &&
    fields.project_milestone_id === undefined
      ? { project_milestone_id: null }
      : {};
  return { ...issue, ...fields, ...cleared, label_ids: labelIds };
};

/** Whether a change would leave an issue as it is. */
export const changeIsNoop = (
  issue: OrderedIssueRead,
  change: IssueChange
): boolean => {
  const next = applyChange(issue, change);
  return (
    next.status_id === issue.status_id &&
    shownStatusId(next) === shownStatusId(issue) &&
    next.priority === issue.priority &&
    next.assignee_id === issue.assignee_id &&
    next.estimate === issue.estimate &&
    next.project_id === issue.project_id &&
    (next.project_milestone_id ?? null) ===
      (issue.project_milestone_id ?? null) &&
    next.cycle_id === issue.cycle_id &&
    (next.start_date ?? null) === (issue.start_date ?? null) &&
    (next.due_date ?? null) === (issue.due_date ?? null) &&
    (next.parent_id ?? null) === (issue.parent_id ?? null) &&
    (next.sort_order ?? null) === (issue.sort_order ?? null) &&
    sameList([...next.label_ids].sort(), [...issue.label_ids].sort())
  );
};

/** The status in the issue's own team that a status group key names. */
export const statusForKey = (
  issue: OrderedIssueRead,
  key: string,
  context: IssueContext
): ScopedStatus | undefined =>
  context.statuses.find(
    (status) =>
      statusGroupKey(status) === key &&
      (status.team_id === undefined || status.team_id === issue.team_id)
  );

/** The labels in the issue's own team that a label group key names. */
const labelsForKey = (
  issue: OrderedIssueRead,
  key: string,
  context: IssueContext
): ScopedLabel[] =>
  context.labels.filter(
    (label) =>
      labelGroupKey(label) === key &&
      (label.team_id === undefined || label.team_id === issue.team_id)
  );

/**
 * The change that moves an issue from one group to another: the grouped
 * property set to the target's value. A label move swaps the source label
 * for the target one and keeps the rest. Answers null when the target cannot
 * be expressed for this issue, such as a status or cycle another team has and
 * this issue's team does not, or a parent, team or SLA column, which only
 * shows where an issue sits.
 */
export const moveChange = (
  issue: OrderedIssueRead,
  field: GroupField,
  fromKey: string,
  toKey: string,
  context: IssueContext
): IssueChange | null => {
  if (fromKey === toKey) return {};
  switch (field) {
    case 'status': {
      if (toKey === TRIAGE_GROUP_KEY) return { status_id: TRIAGE_STATUS_ID };
      const status = statusForKey(issue, toKey, context);
      return status === undefined ? null : { status_id: status.id };
    }
    case 'assignee':
      return { assignee_id: toKey === NONE ? null : toKey };
    case 'priority':
      return (PRIORITIES as string[]).includes(toKey)
        ? { priority: toKey as IssuePriority }
        : null;
    case 'label': {
      const removing =
        fromKey === NONE
          ? []
          : labelsForKey(issue, fromKey, context).map((label) => label.id);
      if (toKey === NONE) {
        return { remove_label_ids: issue.label_ids };
      }
      const adding = labelsForKey(issue, toKey, context).map(
        (label) => label.id
      );
      if (adding.length === 0) return null;
      const replaced = replacedSiblings(
        context.labels,
        issue.label_ids,
        adding
      );
      const dropping = [...new Set([...removing, ...replaced])];
      return {
        add_label_ids: adding,
        ...(dropping.length === 0 ? {} : { remove_label_ids: dropping }),
      };
    }
    case 'milestone': {
      if (toKey === NONE) return { project_milestone_id: null };
      const milestone = context.milestones?.find(
        (entry) => entry.milestone_id === toKey
      );
      return milestone === undefined ||
        milestone.project_id !== issue.project_id
        ? null
        : { project_milestone_id: milestone.milestone_id };
    }
    case 'project': {
      if (toKey === NONE) return { project_id: null };
      const project = context.projects.find(
        (entry) => entry.project_id === toKey
      );
      return project === undefined ||
        (project.team_id !== issue.team_id &&
          !project.team_ids.includes(issue.team_id))
        ? null
        : { project_id: project.project_id };
    }
    case 'cycle': {
      if (toKey === NONE) return { cycle_id: null };
      const cycle = context.cycles.find((entry) => entry.cycle_id === toKey);
      return cycle === undefined || cycle.team_id !== issue.team_id
        ? null
        : { cycle_id: cycle.cycle_id };
    }
    case 'parent':
    case 'team':
    case 'sla':
      return null;
    default:
      return {};
  }
};

/**
 * The manual order key for a card dropped at `index` in a column, reading
 * the neighbours it lands between. Cards never placed sort last, so a drop
 * among them lands just after the last placed card.
 */
export const orderKeyAt = (
  column: OrderedIssueRead[],
  index: number,
  movingId: string
): string => {
  const others = column.filter((issue) => issue.id !== movingId);
  const before = others
    .slice(0, index)
    .map((issue) => issue.sort_order ?? null)
    .filter((key): key is string => key !== null)
    .pop();
  const afterIssue = others[index];
  const after = afterIssue?.sort_order ?? null;
  try {
    return orderBetween(before, after);
  } catch {
    return orderBetween(before, undefined);
  }
};

/** One issue's new manual position, as a keyboard reorder writes it. */
export interface ManualPlacement {
  id: string;
  sort_order: string;
}

/**
 * The manual positions that move one issue a step up or down past its
 * neighbour, given the rows it sits among in display order. Two placed issues
 * swap with one new key. When either has never been placed, every unplaced row
 * up to the pair is placed too, in its shown order, since unplaced rows always
 * sort last and a key for the moving issue alone would not land it beside its
 * neighbour. `reverse` is a manual order read backwards, where keys fall down
 * the list. Null when the issue is at that end of the rows or no key fits.
 */
export const manualMoveKeys = (
  rows: readonly OrderedIssueRead[],
  movingId: string,
  step: 1 | -1,
  reverse = false
): ManualPlacement[] | null => {
  const from = rows.findIndex((issue) => issue.id === movingId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= rows.length) return null;
  const moving = rows[from];
  const neighbour = rows[to];
  if (moving === undefined || neighbour === undefined) return null;
  const moved = [...rows];
  moved[from] = neighbour;
  moved[to] = moving;
  const keyOf = (issue: OrderedIssueRead | undefined): string | null =>
    issue?.sort_order ?? null;
  try {
    if (keyOf(moving) !== null && keyOf(neighbour) !== null) {
      const above = keyOf(moved[to - 1]);
      const below = keyOf(moved[to + 1]);
      return [
        {
          id: movingId,
          sort_order: reverse
            ? orderBetween(below, above)
            : orderBetween(above, below),
        },
      ];
    }
    const firstLoose = rows.findIndex((issue) => keyOf(issue) === null);
    const start = Math.min(from, to, firstLoose);
    const end = Math.max(from, to);
    let bound = keyOf(moved[start - 1]);
    const placements: ManualPlacement[] = [];
    for (let at = start; at <= end; at += 1) {
      const issue = moved[at];
      if (issue === undefined) continue;
      bound = reverse
        ? orderBetween(null, bound)
        : orderBetween(bound, undefined);
      placements.push({ id: issue.id, sort_order: bound });
    }
    return placements;
  } catch {
    return null;
  }
};

/**
 * Whether a view's visibility can be changed by the caller, and where it starts.
 * Only a view without a team moves, a guest cannot publish one, and only its
 * owner may take a workspace view back to private.
 */
export const viewVisibility = (
  view: Pick<SavedViewDisplayRead, 'team_id' | 'scope' | 'owner_id'>,
  userId: string | undefined,
  role: string | undefined
): { rescopable: boolean; initialShared: boolean } => {
  const initialShared = view.scope === 'workspace';
  const rescopable =
    view.team_id === null &&
    (initialShared ? view.owner_id === userId : role !== 'guest');
  return { rescopable, initialShared };
};

/** The `shared` change a details save sends, empty when the visibility held. */
export const sharedChange = (
  view: Pick<SavedViewDisplayRead, 'team_id' | 'scope'>,
  shared: boolean
): { shared?: boolean } =>
  view.team_id === null && shared !== (view.scope === 'workspace')
    ? { shared }
    : {};
