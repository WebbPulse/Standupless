/**
 * The views routes: the board, saved views, search and the inbox. A saved view
 * stores a filter and never a result set, so running one is the M2 issue list
 * with that filter expanded into its query; there is deliberately no route that
 * reads a view's issues, because that would be a second place team
 * visibility is decided.
 */

import type {
  PolledQueryContext,
  PolledResponse,
} from '@webbpulse/api-client/react';
import apiClient from './client';
import { conditionalGet, type ReadContext } from './conditional';
import type { IssueListFilters, IssueListSort } from './issues';
import type {
  BoardQuery,
  BoardRead,
  InboxClearResult,
  InboxBucket,
  InboxClearWrite,
  InboxCountRead,
  InboxReadResult,
  InboxReadWrite,
  InboxSnoozeWrite,
  InboxUnreadWrite,
  IssueReminderListRead,
  IssueReminderRead,
  IssueListRead,
  NotificationListRead,
  NotificationRead,
  ProjectsDisplayPreference,
  SavedViewCreate,
  SavedViewRead,
  SavedViewUpdate,
  SearchListRead,
  SearchResultRead,
  SearchType,
  SimilarIssueRead,
  SimilarListRead,
  StatusCategory,
  ViewFilter,
  ViewGroupBy,
  ViewListScope,
} from '../types/Api';

/** How a saved view is displayed. `kind` stays fixed; this may change. */
export type ViewLayout = 'list' | 'board';

/** How far back a view reaches for issues in a completed or canceled status. */
export type CompletedWindow = 'all' | 'past_week' | 'past_month' | 'none';

/** What a group header reads beside its name: the issue count or the total estimate. */
export type ViewGroupHeader = 'count' | 'estimate';

/** The issue properties a view may show, in the vocabulary the server checks. */
export type ViewVisibleProperty =
  | 'id'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'estimate'
  | 'start_date'
  | 'due_date'
  | 'project'
  | 'cycle'
  | 'parent'
  | 'sub_issues'
  | 'pull_requests'
  | 'milestone'
  | 'links'
  | 'created_at'
  | 'updated_at'
  | 'time_in_status'
  | 'release'
  | 'sla'
  | 'customers'
  | 'customer_revenue';

/** One stored group of conditions, combined under its own `match`, holding groups of its own at most one level down. */
export interface SavedViewFilterGroup {
  [key: string]: string | string[] | SavedViewFilterGroup[];
}

/**
 * The keys a stored filter may carry beside {@link ViewFilter}: the negations,
 * each excluding any issue matching one of its values, and the newer
 * conditions and groups.
 */
export interface ViewFilterNegations {
  subscriber_id?: string | string[];
  subscriber_id_not?: string | string[];
  label_id_all?: string | string[];
  parent_id_not?: string | string[];
  has_sub_issues?: 'true' | 'false';
  completed_after?: string;
  completed_before?: string;
  content?: string;
  content_not?: string;
  match?: 'all' | 'any';
  groups?: SavedViewFilterGroup[];
  team_id_not?: string | string[];
  creator_id_not?: string | string[];
  customer_id_not?: string | string[];
  release_id_not?: string | string[];
  status_id_not?: string | string[];
  status_category_not?: string | string[];
  assignee_id_not?: string | string[];
  label_id_not?: string | string[];
  priority_not?: string | string[];
  cycle_id_not?: string | string[];
  project_id_not?: string | string[];
  project_milestone_id_not?: string | string[];
  estimate_not?: string | string[];
}

/**
 * The keys a view of projects stores: the team narrowed to, the project
 * statuses, the lead (a user id or `none`), whether projects must or must not
 * be blocked or blocking, and whether a parent team rolls up its sub-teams'
 * projects, which an absent key reads as doing.
 */
export interface ProjectViewFilter {
  team_id?: string;
  status?: string | string[];
  lead_id?: string | string[];
  sub_teams?: 'true' | 'false';
  is_blocked?: 'true' | 'false';
  is_blocking?: 'true' | 'false';
  customer_id?: string | string[];
  customer_id_not?: string | string[];
  label_id?: string | string[];
}

/** A stored filter with the negation keys, every key the issue list takes. */
export type SavedViewFilter = ViewFilter & ViewFilterNegations;

/** What a saved view lists. A view saved before projects could be saved reads as issues. */
export type ViewEntity = 'issues' | 'projects';

/** True when the view lists projects rather than issues. */
export const listsProjects = (view: { entity?: ViewEntity }): boolean =>
  view.entity === 'projects';

/**
 * A saved view's display settings. `sub_group_by` needs a distinct `group_by`,
 * a null `ordering` follows `sort`, and a null `visible_properties` means the
 * client's default set. The sub-issue and completed switches are always true
 * or false, a view saved before they existed reading as showing both, and an
 * absent `show_archived` reads as hiding archived issues.
 */
export interface SavedViewDisplay {
  sub_group_by: ViewGroupBy | null;
  ordering: IssueListSort | null;
  /** True when the ordering reads backwards, issues lacking its value still last. */
  ordering_reversed?: boolean;
  visible_properties: ViewVisibleProperty[] | null;
  layout: ViewLayout;
  show_sub_issues: boolean;
  show_completed: boolean;
  /**
   * How far back the view reaches for closed issues. It wins over
   * `show_completed`, which stays in step with it; an older server leaves it
   * out and the switch decides.
   */
  completed_window?: CompletedWindow;
  show_archived?: boolean;
  /** What group headers read; an older server leaves it out, which reads as the count. */
  group_header?: ViewGroupHeader;
  /**
   * The groups, swimlanes and board columns folded away in the view, as the
   * list's own keys; an older server leaves it out, which reads as none.
   */
  collapsed_groups?: string[];
}

/**
 * A saved view as the server now answers it, with its display settings. It
 * stays assignable to {@link SavedViewRead} so existing callers keep compiling,
 * which is why `sort` keeps that type even though a view saved with `manual`
 * answers `manual`; read it through {@link viewSort} to see that value.
 */
export interface SavedViewDisplayRead extends SavedViewRead, SavedViewDisplay {
  filter: SavedViewFilter;
  icon?: string | null;
  color?: ViewColor | null;
  description?: string | null;
  /** Whether the caller starred this view; a star is theirs alone. */
  favorite?: boolean;
  /** Whether the caller follows this view and hears when issues enter it. */
  subscribed?: boolean;
  /** How many members follow this view. */
  subscriber_count?: number;
  /** What the view lists; an older server leaves it out, which reads as issues. */
  entity?: ViewEntity;
  /** A view of projects' arrangement, null on a view of issues. */
  projects_display?: ProjectsDisplayPreference | null;
}

/** The fixed palette a view's icon may take. */
export const VIEW_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;

/** One color from {@link VIEW_COLORS}. */
export type ViewColor = (typeof VIEW_COLORS)[number];

/** The look and description a view is saved with. */
export interface SavedViewLook {
  icon?: string | null;
  color?: ViewColor | null;
  description?: string | null;
}

/** A view's sort in the full list vocabulary, `manual` included. */
export const viewSort = (view: SavedViewRead): IssueListSort => view.sort;

/** A new saved view, including the display settings and the manual sort. */
export interface SavedViewDisplayCreate extends Omit<
  SavedViewCreate,
  'filter' | 'sort'
> {
  filter: SavedViewFilter;
  sort?: IssueListSort;
  sub_group_by?: ViewGroupBy | null;
  ordering?: IssueListSort | null;
  ordering_reversed?: boolean;
  visible_properties?: ViewVisibleProperty[] | null;
  layout?: ViewLayout | null;
  show_sub_issues?: boolean;
  show_completed?: boolean;
  completed_window?: CompletedWindow;
  show_archived?: boolean;
  group_header?: ViewGroupHeader;
  collapsed_groups?: string[];
  icon?: string | null;
  color?: ViewColor | null;
  description?: string | null;
  /** True with no team to share the view with the whole workspace. */
  shared?: boolean;
  /** What the view lists, issues when left out. */
  entity?: ViewEntity;
  /** A view of projects' arrangement, refused on a view of issues. */
  projects_display?: ProjectsDisplayPreference;
}

/** The editable fields on a saved view, including its display settings. */
export interface SavedViewDisplayUpdate extends Omit<
  SavedViewUpdate,
  'filter' | 'sort'
> {
  filter?: SavedViewFilter;
  sort?: IssueListSort;
  sub_group_by?: ViewGroupBy | null;
  ordering?: IssueListSort | null;
  ordering_reversed?: boolean;
  visible_properties?: ViewVisibleProperty[] | null;
  layout?: ViewLayout | null;
  show_sub_issues?: boolean;
  show_completed?: boolean;
  completed_window?: CompletedWindow;
  show_archived?: boolean;
  group_header?: ViewGroupHeader;
  collapsed_groups?: string[];
  icon?: string | null;
  color?: ViewColor | null;
  description?: string | null;
  /** Moves a view without a team between its owner and the whole workspace. */
  shared?: boolean;
  /** A view of projects' new arrangement, merged onto the stored one. */
  projects_display?: Partial<ProjectsDisplayPreference>;
}

const SCALAR_FILTER_KEYS = new Set([
  'team_id',
  'due_before',
  'due_after',
  'created_after',
  'created_before',
  'updated_after',
  'updated_before',
  'q',
  'is_blocked',
  'is_blocking',
  'has_sub_issues',
  'completed_after',
  'completed_before',
  'content',
  'content_not',
  'match',
]);

/**
 * Expands a stored filter into the issue list query that runs it. Running a
 * view is the list route and nothing else, so this is the one place a view's
 * filter meets the list: repeatable keys pass through as arrays, which the
 * client sends as repeated keys, a list left on a single valued key from an
 * older view keeps only its first value rather than failing the read, and the
 * condition groups travel as the JSON text the list route takes.
 */
export const viewFilterToQuery = (
  filter: SavedViewFilter,
  sort?: IssueListSort
): IssueListFilters => {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(filter) as [
    string,
    string | string[] | SavedViewFilterGroup[] | undefined,
  ][]) {
    if (value === undefined) {
      continue;
    }
    if (key === 'groups') {
      if (Array.isArray(value) && value.length > 0) {
        query[key] = JSON.stringify(value);
      }
      continue;
    }
    const entry =
      typeof value === 'string'
        ? value
        : (value as unknown[]).filter(
            (item): item is string => typeof item === 'string'
          );
    if (SCALAR_FILTER_KEYS.has(key)) {
      const first = Array.isArray(entry) ? entry[0] : entry;
      if (first !== undefined) {
        query[key] = first;
      }
      continue;
    }
    query[key] = Array.isArray(entry) ? [...entry] : entry;
  }
  return sort === undefined ? query : { ...query, sort };
};

/** The route the board is read from. */
export const boardPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/board`;

/** The route one board column is paged through. */
export const boardColumnPath = (
  workspaceId: string,
  statusId: string
): string => `${boardPath(workspaceId)}/columns/${statusId}`;

/** The route saved views are listed and created on. */
export const viewsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/views`;

/** The route one saved view is read, edited and deleted through. */
export const viewPath = (workspaceId: string, viewId: string): string =>
  `${viewsPath(workspaceId)}/${viewId}`;

/** The route search is read from. */
export const searchPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/search`;

/** The route possible duplicates of a draft title are read from. */
export const similarIssuesPath = (workspaceId: string): string =>
  `${searchPath(workspaceId)}/similar`;

/** The route the inbox is read from. */
export const inboxPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/inbox`;

/** The route the unread badge counts from. */
export const inboxCountPath = (workspaceId: string): string =>
  `${inboxPath(workspaceId)}/count`;

/** The route rows are marked read on. */
export const inboxReadPath = (workspaceId: string): string =>
  `${inboxPath(workspaceId)}/read`;

/** The route rows are marked unread on. */
export const inboxUnreadPath = (workspaceId: string): string =>
  `${inboxPath(workspaceId)}/unread`;

/** The route the caller's rows are deleted in bulk on. */
export const inboxClearPath = (workspaceId: string): string =>
  `${inboxPath(workspaceId)}/clear`;

/** The route rows are snoozed on. */
export const inboxSnoozePath = (workspaceId: string): string =>
  `${inboxPath(workspaceId)}/snooze`;

/** The route the caller's issue reminders are listed on. */
export const remindersPath = (workspaceId: string): string =>
  `${inboxPath(workspaceId)}/reminders`;

/** The route the caller's reminder on one issue is set and cancelled through. */
export const reminderPath = (workspaceId: string, issueId: string): string =>
  `${remindersPath(workspaceId)}/${encodeURIComponent(issueId)}`;

/** The route one notification is deleted through. */
export const notificationPath = (
  workspaceId: string,
  notificationId: string
): string => `${inboxPath(workspaceId)}/${notificationId}`;

type QueryBag = Record<string, string | number | boolean | undefined>;

const listOptions = (
  query: QueryBag,
  signal?: AbortSignal
): { query: QueryBag; signal?: AbortSignal } =>
  signal === undefined ? { query } : { query, signal };

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/**
 * Reads a whole board in one call. The server queries each of the team's
 * statuses once and caps every column at `column_limit`, so a request's
 * fan-out is bounded by the number of statuses rather than by the backlog.
 */
export const getBoard = async (
  workspaceId: string,
  teamId: string,
  query: BoardQuery = {},
  signal?: AbortSignal
): Promise<BoardRead> => {
  const response = await apiClient.get<BoardRead>(
    boardPath(workspaceId),
    listOptions({ team_id: teamId, ...query }, signal)
  );
  const body = response.data;
  return {
    team_id: body?.team_id ?? teamId,
    columns: Array.isArray(body?.columns) ? body.columns : [],
  };
};

/**
 * Pages one column past its board cap. A deep column is read here rather than
 * by raising `column_limit`, which is what keeps the board request bounded.
 */
export const listBoardColumn = async (
  workspaceId: string,
  statusId: string,
  teamId: string,
  query: BoardQuery & { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<IssueListRead> => {
  const response = await apiClient.get<IssueListRead>(
    boardColumnPath(workspaceId, statusId),
    listOptions({ team_id: teamId, ...query }, signal)
  );
  const body = response.data;
  return {
    issues: Array.isArray(body?.issues) ? body.issues : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** The filter a saved view listing is narrowed by. */
export interface ViewListQuery {
  scope?: ViewListScope;
  team_id?: string;
  entity?: ViewEntity;
}

/**
 * Lists saved views. `mine` is the default the route applies. Handed a polled
 * query's context, the read is conditional on the held ETag.
 */
export function listViews(
  workspaceId: string,
  query?: ViewListQuery,
  signal?: AbortSignal
): Promise<SavedViewDisplayRead[]>;
export function listViews(
  workspaceId: string,
  query: ViewListQuery,
  context: PolledQueryContext
): Promise<PolledResponse<SavedViewDisplayRead[]>>;
export function listViews(
  workspaceId: string,
  query: ViewListQuery = {},
  context?: ReadContext
): Promise<SavedViewDisplayRead[] | PolledResponse<SavedViewDisplayRead[]>> {
  return conditionalGet<
    { views: SavedViewDisplayRead[] },
    SavedViewDisplayRead[]
  >(
    viewsPath(workspaceId),
    (signal) => listOptions({ ...query }, signal),
    context,
    (body) => (Array.isArray(body?.views) ? body.views : [])
  );
}

/**
 * Creates a saved view. `scope` is derived from whether `team_id` is set
 * and `owner_id` comes from the caller's own context, so neither is sent.
 */
export const createView = async (
  workspaceId: string,
  body: SavedViewCreate | SavedViewDisplayCreate
): Promise<SavedViewDisplayRead> => {
  const response = await apiClient.post<SavedViewDisplayRead>(
    viewsPath(workspaceId),
    body
  );
  return response.data;
};

/** Reads one saved view. */
export const getView = async (
  workspaceId: string,
  viewId: string,
  signal?: AbortSignal
): Promise<SavedViewDisplayRead> => {
  const response = await apiClient.get<SavedViewDisplayRead>(
    viewPath(workspaceId, viewId),
    signalOptions(signal)
  );
  return response.data;
};

/** Edits a saved view. Neither its kind nor its team may move. */
export const updateView = async (
  workspaceId: string,
  viewId: string,
  body: SavedViewUpdate | SavedViewDisplayUpdate
): Promise<SavedViewDisplayRead> => {
  const response = await apiClient.patch<SavedViewDisplayRead>(
    viewPath(workspaceId, viewId),
    body
  );
  return response.data;
};

/** One person's folds on a list that is not a saved view. */
export interface ListFoldsRead {
  list_key: string;
  collapsed_groups: string[];
}

/** The route a person's folds on an unsaved list are read and written through. */
export const listFoldsPath = (workspaceId: string): string =>
  `${viewsPath(workspaceId)}/folds`;

/**
 * Reads the caller's folded groups, swimlanes and hidden board columns on one
 * list that is not a saved view, empty when they never folded anything there.
 */
export const getListFolds = async (
  workspaceId: string,
  listKey: string,
  signal?: AbortSignal
): Promise<ListFoldsRead> => {
  const response = await apiClient.get<ListFoldsRead>(
    listFoldsPath(workspaceId),
    { params: { list_key: listKey }, ...signalOptions(signal) }
  );
  return response.data;
};

/** Replaces the caller's folds on one unsaved list; an empty set clears them. */
export const putListFolds = async (
  workspaceId: string,
  listKey: string,
  collapsed: readonly string[]
): Promise<ListFoldsRead> => {
  const response = await apiClient.put<ListFoldsRead>(
    listFoldsPath(workspaceId),
    { list_key: listKey, collapsed_groups: [...collapsed] }
  );
  return response.data;
};

/** The route a saved view is starred and unstarred through. */
export const viewFavoritePath = (workspaceId: string, viewId: string): string =>
  `${viewPath(workspaceId, viewId)}/favorite`;

/** Stars or unstars a saved view for the caller alone. */
export const setViewFavorite = async (
  workspaceId: string,
  viewId: string,
  favorite: boolean
): Promise<SavedViewDisplayRead> => {
  const path = viewFavoritePath(workspaceId, viewId);
  const response = favorite
    ? await apiClient.put<SavedViewDisplayRead>(path)
    : await apiClient.delete<SavedViewDisplayRead>(path);
  return response.data;
};

/** The route a saved view is followed and unfollowed through. */
export const viewSubscriptionPath = (
  workspaceId: string,
  viewId: string
): string => `${viewPath(workspaceId, viewId)}/subscription`;

/** Follows or unfollows a saved view, so issues newly matching it reach the caller's inbox. */
export const setViewSubscription = async (
  workspaceId: string,
  viewId: string,
  subscribed: boolean
): Promise<SavedViewDisplayRead> => {
  const path = viewSubscriptionPath(workspaceId, viewId);
  const response = subscribed
    ? await apiClient.put<SavedViewDisplayRead>(path)
    : await apiClient.delete<SavedViewDisplayRead>(path);
  return response.data;
};

/** Deletes a saved view. */
export const deleteView = async (
  workspaceId: string,
  viewId: string
): Promise<void> => {
  await apiClient.delete<void>(viewPath(workspaceId, viewId));
};

/**
 * Searches the visible teams. The result set is capped rather than paged,
 * because a cursor over an intersection of posting lists is not something the
 * projection can page correctly.
 */
export const search = async (
  workspaceId: string,
  q: string,
  query: { team_id?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<SearchResultRead[]> => {
  const response = await apiClient.get<SearchListRead>(
    searchPath(workspaceId),
    listOptions({ q, ...query }, signal)
  );
  const body = response.data;
  return Array.isArray(body?.results) ? body.results : [];
};

/**
 * Searches the visible teams and, across the workspace, the documents,
 * projects and initiatives the caller can read. A search narrowed to one team
 * answers no documents or initiatives, `type` answers one kind alone, and
 * `status_category` narrows the issue hits.
 */
export const searchAll = async (
  workspaceId: string,
  q: string,
  query: {
    team_id?: string;
    limit?: number;
    type?: SearchType;
    status_category?: StatusCategory;
  } = {},
  signal?: AbortSignal
): Promise<Required<SearchListRead>> => {
  const response = await apiClient.get<SearchListRead>(
    searchPath(workspaceId),
    listOptions({ q, ...query }, signal)
  );
  const body = response.data;
  return {
    results: Array.isArray(body?.results) ? body.results : [],
    documents: Array.isArray(body?.documents) ? body.documents : [],
    projects: Array.isArray(body?.projects) ? body.projects : [],
    initiatives: Array.isArray(body?.initiatives) ? body.initiatives : [],
    comments: Array.isArray(body?.comments) ? body.comments : [],
  };
};

/**
 * Open issues in the visible teams whose titles share terms with a draft
 * title, best match first, with `team_id`'s issues ranked ahead of the rest.
 * A title with no searchable word answers nothing.
 */
export const similarIssues = async (
  workspaceId: string,
  title: string,
  query: { limit?: number; exclude_issue_id?: string; team_id?: string } = {},
  signal?: AbortSignal
): Promise<SimilarIssueRead[]> => {
  const response = await apiClient.get<SimilarListRead>(
    similarIssuesPath(workspaceId),
    listOptions({ title, ...query }, signal)
  );
  const body = response.data;
  return Array.isArray(body?.results) ? body.results : [];
};

/**
 * Lists the caller's inbox, newest first. There is no recipient parameter: the
 * partition is built from the caller's own context, so no route reads another
 * member's rows.
 */
export const listInbox = async (
  workspaceId: string,
  query: {
    unread?: boolean;
    snoozed?: boolean;
    include_snoozed?: boolean;
    kind?: string[];
    bucket?: InboxBucket;
    cursor?: string;
    limit?: number;
  } = {},
  signal?: AbortSignal
): Promise<NotificationListRead> => {
  const response = await apiClient.get<NotificationListRead>(
    inboxPath(workspaceId),
    signal === undefined ? { query } : { query, signal }
  );
  const body = response.data;
  return {
    notifications: Array.isArray(body?.notifications) ? body.notifications : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/**
 * Reads every unread count: the total, each tab of the split inbox and the
 * badge. Each saturates at 100.
 */
export const getInboxCounts = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<Required<InboxCountRead>> => {
  const response = await apiClient.get<InboxCountRead>(
    inboxCountPath(workspaceId),
    signalOptions(signal)
  );
  const unread = response.data?.unread ?? 0;
  return {
    unread,
    priority_unread: response.data?.priority_unread ?? 0,
    other_unread: response.data?.other_unread ?? 0,
    priority_inbox: response.data?.priority_inbox ?? false,
    badge: response.data?.badge ?? unread,
  };
};

/**
 * Counts the unread rows for the badge, which keeps to the Priority tab while
 * the split inbox is on. It reads the sparse index rather than filtering the
 * list, and the answer saturates at 100.
 */
export const getInboxCount = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<number> => {
  const response = await apiClient.get<InboxCountRead>(
    inboxCountPath(workspaceId),
    signalOptions(signal)
  );
  return response.data?.badge ?? response.data?.unread ?? 0;
};

/**
 * Marks rows read, either the named ones or every one. Marking read deletes
 * the row's `unread_at`, which drops it out of the sparse index in the same
 * write, so the badge and the list cannot disagree.
 */
export const markRead = async (
  workspaceId: string,
  body: InboxReadWrite
): Promise<number> => {
  const response = await apiClient.post<InboxReadResult>(
    inboxReadPath(workspaceId),
    body
  );
  return response.data?.updated ?? 0;
};

/** Marks every row read in one call, or only the rows of the given kinds or tab. */
export const markAllRead = async (
  workspaceId: string,
  kinds: string[] = [],
  bucket: InboxBucket = 'all'
): Promise<number> =>
  markRead(workspaceId, {
    all: true,
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(bucket === 'all' ? {} : { bucket }),
  });

/**
 * Deletes the caller's rows in bulk, read ones only or all of them, and
 * reports how many went.
 */
export const clearInbox = async (
  workspaceId: string,
  body: InboxClearWrite
): Promise<number> => {
  const response = await apiClient.post<InboxClearResult>(
    inboxClearPath(workspaceId),
    body
  );
  return response.data?.deleted ?? 0;
};

/**
 * Marks rows unread again, which also ends any snooze on them. Ids already
 * unread or not in the caller's inbox count as nothing changed.
 */
export const markUnread = async (
  workspaceId: string,
  body: InboxUnreadWrite
): Promise<number> => {
  const response = await apiClient.post<InboxReadResult>(
    inboxUnreadPath(workspaceId),
    body
  );
  return response.data?.updated ?? 0;
};

/**
 * Snoozes rows until a moment. They leave the inbox and the badge until then
 * and come back unread by themselves, with nothing to poll for.
 */
export const snoozeNotifications = async (
  workspaceId: string,
  body: InboxSnoozeWrite
): Promise<number> => {
  const response = await apiClient.post<InboxReadResult>(
    inboxSnoozePath(workspaceId),
    body
  );
  return response.data?.updated ?? 0;
};

/**
 * Lists the caller's pending issue reminders, soonest first, optionally on one
 * issue alone. A reminder on an issue the caller can no longer see is left out.
 */
export const listReminders = async (
  workspaceId: string,
  issueId?: string,
  signal?: AbortSignal
): Promise<IssueReminderRead[]> => {
  const response = await apiClient.get<IssueReminderListRead>(
    remindersPath(workspaceId),
    listOptions({ issue_id: issueId }, signal)
  );
  const reminders = response.data?.reminders;
  return Array.isArray(reminders) ? reminders : [];
};

/**
 * Reminds the caller about one issue at a moment, replacing any reminder they
 * already set on it. The moment carries its offset, so presets are the
 * caller's own clock.
 */
export const setReminder = async (
  workspaceId: string,
  issueId: string,
  remindAt: string
): Promise<IssueReminderRead> => {
  const response = await apiClient.put<IssueReminderRead>(
    reminderPath(workspaceId, issueId),
    { remind_at: remindAt }
  );
  return response.data;
};

/** Cancels the caller's pending reminder on one issue. */
export const cancelReminder = async (
  workspaceId: string,
  issueId: string
): Promise<void> => {
  await apiClient.delete<void>(reminderPath(workspaceId, issueId));
};

/** Deletes one notification. */
export const deleteNotification = async (
  workspaceId: string,
  notificationId: string
): Promise<void> => {
  await apiClient.delete<void>(notificationPath(workspaceId, notificationId));
};

/** An empty inbox page, for a query disabled before its ids are known. */
export const emptyInboxPage = (): NotificationListRead => ({
  notifications: [],
  next_cursor: null,
});

/** Appends a cursor page of notifications, dropping a repeated row. */
export const appendNotifications = (
  held: NotificationRead[],
  incoming: NotificationRead[]
): NotificationRead[] => {
  const seen = new Set(held.map((row) => row.notification_id));
  return [...held, ...incoming.filter((row) => !seen.has(row.notification_id))];
};
