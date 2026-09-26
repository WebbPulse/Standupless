/**
 * The views routes: the board, saved views, search and the inbox. A saved view
 * stores a filter and never a result set, so running one is the M2 issue list
 * with that filter expanded into its query; there is deliberately no route that
 * reads a view's issues, because that would be a second place team
 * visibility is decided.
 */

import apiClient from './client';
import type { IssueListFilters, IssueListSort } from './issues';
import type {
  BoardQuery,
  BoardRead,
  InboxCountRead,
  InboxReadResult,
  InboxReadWrite,
  IssueListRead,
  NotificationListRead,
  NotificationRead,
  SavedViewCreate,
  SavedViewRead,
  SavedViewUpdate,
  SearchListRead,
  SearchResultRead,
  ViewFilter,
  ViewGroupBy,
  ViewListScope,
} from '../types/Api';

/** How a saved view is displayed. `kind` stays fixed; this may change. */
export type ViewLayout = 'list' | 'board';

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
  | 'created_at'
  | 'updated_at';

/**
 * The negation keys a stored filter may carry beside {@link ViewFilter}, each
 * excluding any issue matching one of its values.
 */
export interface ViewFilterNegations {
  status_id_not?: string | string[];
  status_category_not?: string | string[];
  assignee_id_not?: string | string[];
  label_id_not?: string | string[];
  priority_not?: string | string[];
  cycle_id_not?: string | string[];
  project_id_not?: string | string[];
}

/** A stored filter with the negation keys, every key the issue list takes. */
export type SavedViewFilter = ViewFilter & ViewFilterNegations;

/**
 * A saved view's display settings. `sub_group_by` needs a distinct `group_by`,
 * a null `ordering` follows `sort`, and a null `visible_properties` means the
 * client's default set.
 */
export interface SavedViewDisplay {
  sub_group_by: ViewGroupBy | null;
  ordering: IssueListSort | null;
  visible_properties: ViewVisibleProperty[] | null;
  layout: ViewLayout;
}

/**
 * A saved view as the server now answers it, with its display settings. It
 * stays assignable to {@link SavedViewRead} so existing callers keep compiling,
 * which is why `sort` keeps that type even though a view saved with `manual`
 * answers `manual`; read it through {@link viewSort} to see that value.
 */
export interface SavedViewDisplayRead extends SavedViewRead, SavedViewDisplay {
  filter: SavedViewFilter;
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
  visible_properties?: ViewVisibleProperty[] | null;
  layout?: ViewLayout | null;
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
  visible_properties?: ViewVisibleProperty[] | null;
  layout?: ViewLayout | null;
}

const SCALAR_FILTER_KEYS = new Set(['team_id', 'due_before', 'due_after', 'q']);

/**
 * Expands a stored filter into the issue list query that runs it. Running a
 * view is the list route and nothing else, so this is the one place a view's
 * filter meets the list: repeatable keys pass through as arrays, which the
 * client sends as repeated keys, and a list left on a single valued key from
 * an older view keeps only its first value rather than failing the read.
 */
export const viewFilterToQuery = (
  filter: SavedViewFilter,
  sort?: IssueListSort
): IssueListFilters => {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(filter) as [
    string,
    string | string[] | undefined,
  ][]) {
    if (value === undefined) {
      continue;
    }
    if (SCALAR_FILTER_KEYS.has(key)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (first !== undefined) {
        query[key] = first;
      }
      continue;
    }
    query[key] = Array.isArray(value) ? [...value] : value;
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

/** The route the inbox is read from. */
export const inboxPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/inbox`;

/** The route the unread badge counts from. */
export const inboxCountPath = (workspaceId: string): string =>
  `${inboxPath(workspaceId)}/count`;

/** The route rows are marked read on. */
export const inboxReadPath = (workspaceId: string): string =>
  `${inboxPath(workspaceId)}/read`;

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

/** Lists saved views. `mine` is the default the route applies. */
export const listViews = async (
  workspaceId: string,
  query: { scope?: ViewListScope; team_id?: string } = {},
  signal?: AbortSignal
): Promise<SavedViewDisplayRead[]> => {
  const response = await apiClient.get<{ views: SavedViewDisplayRead[] }>(
    viewsPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return Array.isArray(body?.views) ? body.views : [];
};

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
 * Lists the caller's inbox, newest first. There is no recipient parameter: the
 * partition is built from the caller's own context, so no route reads another
 * member's rows.
 */
export const listInbox = async (
  workspaceId: string,
  query: { unread?: boolean; cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<NotificationListRead> => {
  const response = await apiClient.get<NotificationListRead>(
    inboxPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    notifications: Array.isArray(body?.notifications) ? body.notifications : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/**
 * Counts the unread rows for the badge. It reads the sparse index rather than
 * filtering the list, and the answer saturates at 100.
 */
export const getInboxCount = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<number> => {
  const response = await apiClient.get<InboxCountRead>(
    inboxCountPath(workspaceId),
    signalOptions(signal)
  );
  return response.data?.unread ?? 0;
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

/** Marks every row read in one call. */
export const markAllRead = async (workspaceId: string): Promise<number> =>
  markRead(workspaceId, { all: true });

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
