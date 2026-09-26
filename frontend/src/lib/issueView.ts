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
  SavedViewDisplayCreate,
  SavedViewDisplayRead,
  SavedViewFilter,
  ViewLayout,
  ViewVisibleProperty,
} from '../api/views';
import type {
  CycleRead,
  IssuePriority,
  LabelRead,
  ProjectRead,
  StatusCategory,
  StatusRead,
  ViewGroupBy,
} from '../types/Api';
import { PRIORITIES, PRIORITY_LABELS } from './issueDisplay';
import { personLabel, type Assignable } from './issuePeople';
import { STATUS_CATEGORY_ORDER } from './propertyOptions';

/** A property an issue list can be grouped by, or `none`. */
export type GroupField = ViewGroupBy | 'none';

/** The properties a list can be filtered on. */
export type FilterField =
  'status' | 'assignee' | 'priority' | 'label' | 'project' | 'cycle';

/** Whether a filter keeps or excludes the issues matching its values. */
export type FilterOp = 'is' | 'is_not';

/** One filter: a property, whether it keeps or excludes, and any of its values. */
export interface FilterClause {
  field: FilterField;
  op: FilterOp;
  values: string[];
}

/** Everything a list or board is drawn from. */
export interface ViewState {
  filters: FilterClause[];
  /** Free text the list route matches, kept when a saved view carries it. */
  q: string;
  groupBy: GroupField;
  subGroupBy: GroupField;
  ordering: IssueListSort;
  visible: ViewVisibleProperty[];
  layout: ViewLayout;
  showEmpty: boolean;
}

/** A status with the team it belongs to, for a list that spans teams. */
export interface ScopedStatus extends StatusRead {
  team_id?: string;
}

/** A label with the team it belongs to, for a list that spans teams. */
export interface ScopedLabel extends LabelRead {
  team_id?: string;
}

/** The lists ids are resolved against when grouping and labelling. */
export interface IssueContext {
  statuses: ScopedStatus[];
  labels: ScopedLabel[];
  people: Assignable[];
  projects: ProjectRead[];
  cycles: CycleRead[];
  /** The signed in person, listed first and marked in pickers. */
  currentUserId?: string;
}

/** The fields a list can be grouped by, in menu order. */
export const GROUP_FIELDS: GroupField[] = [
  'status',
  'assignee',
  'priority',
  'label',
  'none',
];

/** How a grouping reads in the interface. */
export const GROUP_LABELS: Record<GroupField, string> = {
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  label: 'Label',
  none: 'No grouping',
};

/** The orderings a list offers, in menu order. */
export const ORDERINGS: IssueListSort[] = [
  'manual',
  'priority_desc',
  'updated_desc',
  'created_desc',
  'due_asc',
  'key_asc',
];

/** How an ordering reads in the interface. */
export const ORDERING_LABELS: Record<IssueListSort, string> = {
  manual: 'Manual',
  priority_desc: 'Priority',
  updated_desc: 'Last updated',
  created_desc: 'Created',
  due_asc: 'Due date',
  key_asc: 'Issue ID',
};

/** The filterable fields, in menu order. */
export const FILTER_FIELDS: FilterField[] = [
  'status',
  'assignee',
  'priority',
  'label',
  'project',
  'cycle',
];

/** How a filter field reads in the interface. */
export const FILTER_LABELS: Record<FilterField, string> = {
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  label: 'Labels',
  project: 'Project',
  cycle: 'Cycle',
};

/** The list query key each filter field maps to. */
const FILTER_KEYS: Record<FilterField, string> = {
  status: 'status_id',
  assignee: 'assignee_id',
  priority: 'priority',
  label: 'label_id',
  project: 'project_id',
  cycle: 'cycle_id',
};

/** The properties a row can show, in the order they are drawn. */
export const DISPLAY_PROPERTIES: ViewVisibleProperty[] = [
  'priority',
  'id',
  'status',
  'sub_issues',
  'labels',
  'project',
  'cycle',
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
  'project',
  'estimate',
  'due_date',
  'assignee',
];

/** The state a list opens in with nothing in the URL. */
export const defaultViewState = (layout: ViewLayout = 'list'): ViewState => ({
  filters: [],
  q: '',
  groupBy: 'status',
  subGroupBy: 'none',
  ordering: 'priority_desc',
  visible: [...DEFAULT_VISIBLE],
  layout,
  showEmpty: layout === 'board',
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
  const values = raw
    .slice(colon + 1)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (field === undefined || !isFilterField(field) || values.length === 0) {
    return null;
  }
  return { field, op: op === 'not' ? 'is_not' : 'is', values };
};

/** Writes one clause as its `f` parameter. */
const writeClause = (clause: FilterClause): string =>
  `${clause.field}.${clause.op === 'is_not' ? 'not' : 'is'}:${clause.values.join(',')}`;

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const sameFilters = (left: FilterClause[], right: FilterClause[]): boolean =>
  sameList(left.map(writeClause), right.map(writeClause));

/** Whether two states draw the same list. */
export const sameViewState = (left: ViewState, right: ViewState): boolean =>
  sameFilters(left.filters, right.filters) &&
  left.q === right.q &&
  left.groupBy === right.groupBy &&
  left.subGroupBy === right.subGroupBy &&
  left.ordering === right.ordering &&
  sameList(left.visible, right.visible) &&
  left.layout === right.layout &&
  left.showEmpty === right.showEmpty;

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
  const layoutParam = params.get('layout');
  const layout: ViewLayout =
    layoutParam === 'board' || layoutParam === 'list'
      ? layoutParam
      : base.layout;
  const group = params.get('group');
  const sub = params.get('sub');
  const order = params.get('order');
  const props = params.get('props');
  const empty = params.get('empty');
  const groupBy = isGroupField(group) ? group : base.groupBy;
  const subGroupBy = isGroupField(sub) ? sub : base.subGroupBy;
  return {
    filters,
    q: params.get('q') ?? base.q,
    groupBy,
    subGroupBy: subGroupBy === groupBy ? 'none' : subGroupBy,
    ordering: isOrdering(order) ? order : base.ordering,
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
      !['f', 'q', 'group', 'sub', 'order', 'props', 'layout', 'empty'].includes(
        key
      )
    ) {
      params.append(key, value);
    }
  }
  if (!sameFilters(state.filters, base.filters)) {
    if (state.filters.length === 0) params.append('f', '');
    for (const clause of state.filters) params.append('f', writeClause(clause));
  }
  if (state.q !== base.q) params.set('q', state.q);
  if (state.layout !== base.layout) params.set('layout', state.layout);
  if (state.groupBy !== base.groupBy) params.set('group', state.groupBy);
  if (state.subGroupBy !== base.subGroupBy) params.set('sub', state.subGroupBy);
  if (state.ordering !== base.ordering) params.set('order', state.ordering);
  if (!sameList(state.visible, base.visible)) {
    params.set('props', state.visible.join(','));
  }
  const emptyDefault =
    state.layout === base.layout ? base.showEmpty : state.layout === 'board';
  if (state.showEmpty !== emptyDefault) {
    params.set('empty', state.showEmpty ? '1' : '0');
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

/** The list query a state runs, on top of the fixed scope such as a team. */
export const viewStateQuery = (
  state: ViewState,
  scope: IssueListFilters = {}
): IssueListFilters => {
  const query: Record<string, string | string[]> = {};
  for (const clause of state.filters) {
    const key = `${FILTER_KEYS[clause.field]}${clause.op === 'is_not' ? '_not' : ''}`;
    const held = query[key];
    const merged = [
      ...(held === undefined ? [] : Array.isArray(held) ? held : [held]),
      ...clause.values,
    ];
    query[key] = [...new Set(merged)];
  }
  return {
    ...scope,
    ...(query as IssueListFilters),
    ...(state.q === '' ? {} : { q: state.q }),
    sort: state.ordering,
  };
};

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Reads a saved view back into the state it was saved from. */
export const viewToState = (view: SavedViewDisplayRead): ViewState => {
  const filter = view.filter as Record<string, string | string[] | undefined>;
  const filters: FilterClause[] = [];
  for (const field of FILTER_FIELDS) {
    const key = FILTER_KEYS[field];
    const kept = asList(filter[key]);
    const dropped = asList(filter[`${key}_not`]);
    if (kept.length > 0) filters.push({ field, op: 'is', values: kept });
    if (dropped.length > 0) {
      filters.push({ field, op: 'is_not', values: dropped });
    }
  }
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
    filters,
    q: typeof filter['q'] === 'string' ? filter['q'] : '',
    groupBy,
    subGroupBy: sub === groupBy ? 'none' : sub,
    ordering: isOrdering(ordering) ? ordering : 'priority_desc',
    visible: view.visible_properties ?? [...DEFAULT_VISIBLE],
    layout,
    showEmpty: layout === 'board',
  };
};

/**
 * The stored filter keys a view carries that the filter bar does not edit:
 * its team, a status category, a parent, a due window. They are the fixed
 * scope the view runs under, kept as they are when the view is updated.
 */
const SCOPE_KEYS = [
  'team_id',
  'status_category',
  'status_category_not',
  'parent_id',
  'due_before',
  'due_after',
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
    if (key !== 'sort' && key !== 'cursor' && key !== 'limit')
      filter[key] = value;
  }
  return filter;
};

/** The display settings a state saves as. */
export const stateToViewDisplay = (
  state: ViewState
): Pick<
  SavedViewDisplayCreate,
  | 'sort'
  | 'ordering'
  | 'group_by'
  | 'sub_group_by'
  | 'visible_properties'
  | 'layout'
> => ({
  sort: state.ordering,
  ordering: state.ordering,
  group_by: state.groupBy === 'none' ? null : state.groupBy,
  sub_group_by:
    state.subGroupBy === 'none' || state.subGroupBy === state.groupBy
      ? null
      : state.subGroupBy,
  visible_properties: state.visible,
  layout: state.layout,
});

/**
 * The saved view body a state creates. `shareWith` makes it a team view that
 * everyone in that team sees; without it the view is the caller's own.
 */
export const stateToViewBody = (
  state: ViewState,
  name: string,
  scope: IssueListFilters = {},
  shareWith?: string
): SavedViewDisplayCreate => ({
  name,
  kind: state.layout,
  filter: stateToViewFilter(state, scope),
  ...stateToViewDisplay(state),
  ...(shareWith === undefined ? {} : { team_id: shareWith }),
});

/** The key statuses are grouped under, shared by like named statuses across teams. */
export const statusGroupKey = (status: StatusRead): string =>
  `${status.category}:${status.name.trim().toLowerCase()}`;

/** The key labels are grouped under, shared by like named labels across teams. */
export const labelGroupKey = (label: LabelRead): string =>
  label.name.trim().toLowerCase();

/** One group of rows and how its header reads. */
export interface IssueGroup {
  key: string;
  field: GroupField;
  label: string;
  /** The status category, for a status group's glyph. */
  category?: StatusCategory;
  /** The priority, for a priority group's glyph. */
  priority?: IssuePriority;
  /** The label colour, for a label group's dot. */
  color?: string;
  /** The person's name, for an assignee group's avatar. */
  person?: string;
  issues: OrderedIssueRead[];
}

/** The status an issue sits in, resolved against its own team when known. */
export const statusOf = (
  issue: OrderedIssueRead,
  context: IssueContext
): ScopedStatus | undefined =>
  context.statuses.find((status) => status.id === issue.status_id);

/** The labels an issue carries, in the order the team lists them. */
export const labelsOf = (
  issue: OrderedIssueRead,
  context: IssueContext
): ScopedLabel[] =>
  context.labels.filter((label) => issue.label_ids.includes(label.id));

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
    default:
      return ['all'];
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
      for (const label of [...context.labels].sort((left, right) =>
        left.name.localeCompare(right.name)
      )) {
        const key = labelGroupKey(label);
        if (seen.has(key)) continue;
        seen.add(key);
        shells.push({ key, field, label: label.name, color: label.color });
      }
      return shells;
    }
    default:
      return [{ key: 'all', field, label: 'All issues' }];
  }
};

/**
 * Splits rows into groups in display order. Rows keep their order inside a
 * group. A group with no rows is kept only when `showEmpty` is set, and a
 * row whose value is missing from the lists, such as someone who has left
 * the team, gets a group of its own rather than disappearing.
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
      if (group === undefined) {
        group = {
          key,
          field,
          label:
            field === 'assignee'
              ? 'Unknown person'
              : field === 'status'
                ? 'Unknown status'
                : key,
          ...(field === 'assignee' ? { person: '?' } : {}),
          issues: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.issues.push(issue);
    }
  }
  return showEmpty || field === 'none'
    ? groups
    : groups.filter((group) => group.issues.length > 0);
};

const PRIORITY_RANK: Record<IssuePriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

/**
 * Orders rows the way the list route does, so an optimistic change lands in
 * its new place at once rather than on the next read. Ties keep their
 * incoming order.
 */
export const sortIssues = (
  issues: OrderedIssueRead[],
  ordering: IssueListSort
): OrderedIssueRead[] => {
  const indexed = issues.map((issue, index) => ({ issue, index }));
  const compare = (left: OrderedIssueRead, right: OrderedIssueRead): number => {
    switch (ordering) {
      case 'manual': {
        const a = left.sort_order ?? null;
        const b = right.sort_order ?? null;
        if (a === b) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return a < b ? -1 : 1;
      }
      case 'priority_desc':
        return PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
      case 'updated_desc':
        return right.updated_at.localeCompare(left.updated_at);
      case 'created_desc':
        return right.created_at.localeCompare(left.created_at);
      case 'due_asc': {
        const a = left.due_date;
        const b = right.due_date;
        if (a === b) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return a.localeCompare(b);
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
  return indexed
    .sort(
      (left, right) =>
        compare(left.issue, right.issue) || left.index - right.index
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
  cycle_id?: string | null;
  sort_order?: string;
}

/** Lays a change over an issue, adding and removing labels rather than replacing them. */
export const applyChange = (
  issue: OrderedIssueRead,
  change: IssueChange
): OrderedIssueRead => {
  const { add_label_ids, remove_label_ids, ...fields } = change;
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
  return { ...issue, ...fields, label_ids: labelIds };
};

/** Whether a change would leave an issue as it is. */
export const changeIsNoop = (
  issue: OrderedIssueRead,
  change: IssueChange
): boolean => {
  const next = applyChange(issue, change);
  return (
    next.status_id === issue.status_id &&
    next.priority === issue.priority &&
    next.assignee_id === issue.assignee_id &&
    next.estimate === issue.estimate &&
    next.project_id === issue.project_id &&
    next.cycle_id === issue.cycle_id &&
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
 * be expressed for this issue, such as a status another team has and this
 * issue's team does not.
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
      return {
        add_label_ids: adding,
        ...(removing.length === 0 ? {} : { remove_label_ids: removing }),
      };
    }
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
