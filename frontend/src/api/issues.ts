/**
 * The issue routes: issues themselves, their children, their links and their
 * activity. Issues are workspace scoped rather than nested under a team, so
 * a link and the "my issues" read can cross teams without a second call.
 */

import apiClient from './client';
import type { QueryValue } from '@webbpulse/api-client';
import { polledResponse } from '@webbpulse/api-client/react';
import type {
  ActivityListRead,
  ActivityRead,
  IssueCreate,
  IssueExportRead,
  IssueListQuery,
  IssueListRead,
  IssueMove,
  IssuePriority,
  IssueRead,
  IssueSort,
  IssueUpdate,
  LinkCreate,
  LinkListRead,
  LinkRead,
  LinkType,
  SlaStatus,
  StatusCategory,
} from '../types/Api';

/** The route a workspace's issues are read from. */
export const issuesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/issues`;

/** The route a workspace's issues are exported from as CSV, a page at a time. */
export const issuesExportPath = (workspaceId: string): string =>
  `${issuesPath(workspaceId)}/export`;

/** The route one issue is read from. */
export const issuePath = (workspaceId: string, issueId: string): string =>
  `${issuesPath(workspaceId)}/${issueId}`;

/** The route one issue is read from by its human key, such as `ENG-12`. */
export const issueByKeyPath = (workspaceId: string, key: string): string =>
  `${issuesPath(workspaceId)}/by-key/${encodeURIComponent(key)}`;

/** The route an issue's direct children are read from. */
export const issueChildrenPath = (
  workspaceId: string,
  issueId: string
): string => `${issuePath(workspaceId, issueId)}/children`;

/** The route an issue's links are read from. */
export const issueLinksPath = (workspaceId: string, issueId: string): string =>
  `${issuePath(workspaceId, issueId)}/links`;

/** The route an issue's activity is read from. */
export const issueActivityPath = (
  workspaceId: string,
  issueId: string
): string => `${issuePath(workspaceId, issueId)}/activity`;

/**
 * The literal the list route accepts in place of a user id, so a caller can
 * filter to itself without first reading who it is.
 */
export const ME = 'me';

/**
 * The literal the list route reads as "unset": unassigned, unlabelled, no
 * project, no cycle or top level. On `priority` it is the stored priority.
 */
export const NONE = 'none';

/** The largest batch the bulk patch accepts, matching the server's cap. */
export const BULK_MAX_ISSUES = 50;

/**
 * The list sorts, including `manual`, which orders by each issue's
 * `sort_order` and puts issues that were never placed last.
 */
export type IssueListSort = IssueSort | 'manual';

/** One filter value or several, which the route reads as any of. */
export type FilterValues<T extends string = string> = T | T[];

/**
 * The full issue list query. Every repeatable key serialises as repeated
 * query keys, values within a key are any of, keys must all hold, and each
 * `_not` key excludes. A plain {@link IssueListQuery} is still a valid value.
 */
export interface IssueListFilters {
  team_id?: string;
  /** Narrows a workspace list to these teams. */
  team_id_in?: FilterValues;
  team_id_not?: FilterValues;
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
  status_id?: FilterValues;
  status_id_not?: FilterValues;
  status_category?: FilterValues<StatusCategory | 'canceled'>;
  status_category_not?: FilterValues<StatusCategory | 'canceled'>;
  assignee_id?: FilterValues;
  assignee_id_not?: FilterValues;
  creator_id?: FilterValues;
  creator_id_not?: FilterValues;
  subscriber_id?: string;
  label_id?: FilterValues;
  label_id_not?: FilterValues;
  priority?: FilterValues<IssuePriority>;
  priority_not?: FilterValues<IssuePriority>;
  parent_id?: FilterValues;
  cycle_id?: FilterValues;
  cycle_id_not?: FilterValues;
  project_id?: FilterValues;
  project_id_not?: FilterValues;
  project_milestone_id?: FilterValues;
  project_milestone_id_not?: FilterValues;
  /** Estimates such as `M` or `3`; `none` is unestimated. */
  estimate?: FilterValues;
  estimate_not?: FilterValues;
  due_before?: string;
  due_after?: string;
  /** Where issues stand against their SLA; `none` is no SLA. */
  sla_status?: FilterValues<SlaStatus>;
  /** `true` for issues an open blocker holds up, `false` for the rest. */
  is_blocked?: 'true' | 'false';
  /** `true` for open issues that block another. */
  is_blocking?: 'true' | 'false';
  /** Issues holding a link of any of these types. */
  has_relation?: FilterValues<LinkType>;
  q?: string;
  /** True to list archived issues too, which the list leaves out by default. */
  include_archived?: boolean;
  /** True to list only archived issues, the archive view. */
  archived_only?: boolean;
  /** True to add the sub-teams of `team_id` the caller can see, rolling them up. */
  include_sub_teams?: boolean;
  sort?: IssueListSort;
  cursor?: string;
  limit?: number;
  /**
   * A `synced_at` from an earlier read. The answer is then only what changed
   * since, unpaged, with `removed_ids` for the rows to drop.
   */
  updated_since?: string;
}

/**
 * An issue with its manual position. `sort_order` is a fractional index over
 * `[0-9A-Za-z]`, null until the issue is first placed.
 */
export interface OrderedIssueRead extends IssueRead {
  sort_order?: string | null;
}

/** The single issue patch, plus the manual position, which records no activity. */
export interface IssueOrderUpdate extends IssueUpdate {
  sort_order?: string | null;
}

/**
 * The partial patch a bulk edit applies to every named issue. An explicit null
 * clears a field and an absent one is left alone; labels are added and removed
 * rather than replaced, so each issue keeps its other labels.
 */
export interface IssueBulkPatch {
  status_id?: string;
  assignee_id?: string | null;
  priority?: IssuePriority;
  add_label_ids?: string[];
  remove_label_ids?: string[];
  project_id?: string | null;
  project_milestone_id?: string | null;
  cycle_id?: string | null;
  estimate?: string | null;
  /** True archives every named issue and false restores them. */
  archived?: boolean;
}

/** The bulk patch body: up to {@link BULK_MAX_ISSUES} ids and one patch. */
export interface IssueBulkUpdate {
  issue_ids: string[];
  patch: IssueBulkPatch;
  /** Write only issues whose estimate is this now, `none` for unestimated; the rest are skipped. */
  only_if_estimate?: string;
}

/**
 * The bulk patch answer. `issues` keeps request order; `skipped` names issues
 * deleted between the server's check and its write, or whose estimate did not
 * match `only_if_estimate`, the only per item outcomes, since every other
 * refusal fails the whole batch before anything is written.
 */
export interface IssueBulkRead {
  issues: OrderedIssueRead[];
  skipped: string[];
}

/**
 * The key a new row takes between two neighbours in a manual order, either
 * of which may be absent at an end. Keys are compared bytewise over the base
 * 62 alphabet, the same order the server sorts by.
 */
export const orderBetween = (
  before: string | null | undefined,
  after: string | null | undefined
): string => {
  const digits =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const low = before ?? '';
  const high = after ?? '';
  if (high !== '' && low >= high) {
    throw new Error('orderBetween needs before to sort ahead of after');
  }
  let key = '';
  let bounded = high !== '';
  for (let index = 0; ; index += 1) {
    if (bounded && index >= high.length) {
      throw new Error('no key sorts ahead of an all zero key');
    }
    const lowDigit = index < low.length ? digits.indexOf(low[index] ?? '') : 0;
    const highDigit = bounded
      ? digits.indexOf(high[index] ?? '')
      : digits.length;
    if (highDigit - lowDigit > 1) {
      return key + digits[Math.floor((lowDigit + highDigit) / 2)];
    }
    if (highDigit > lowDigit) {
      bounded = false;
    }
    key += digits[lowDigit];
  }
};

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

const listOptions = (
  query: Record<string, QueryValue>,
  signal?: AbortSignal
): {
  query: Record<string, QueryValue>;
  signal?: AbortSignal;
} => (signal === undefined ? { query } : { query, signal });

const emptyIssuePage = (): IssueListRead => ({ issues: [], next_cursor: null });

const readIssuePage = (body: IssueListRead | undefined): IssueListRead => ({
  issues: Array.isArray(body?.issues) ? body.issues : [],
  next_cursor: body?.next_cursor ?? null,
  synced_at: body?.synced_at ?? null,
  removed_ids: Array.isArray(body?.removed_ids) ? body.removed_ids : [],
  resync_required: body?.resync_required === true,
});

/**
 * Lists issues, one cursor page at a time. Without `team_id` the server fans
 * out across every team the caller can see and merges by the sort key, which
 * is what makes a cross-team view one request rather than a loop.
 */
export const listIssues = async (
  workspaceId: string,
  query: IssueListQuery | IssueListFilters = {},
  signal?: AbortSignal
): Promise<IssueListRead> => {
  const response = await apiClient.get<IssueListRead>(
    issuesPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  return readIssuePage(response.data);
};

/** A delta read of the list, or null for a 304, with the tag to send next. */
export interface IssueDeltaRead {
  /** The delta, or null when the server said nothing changed. */
  page: IssueListRead | null;
  /** The weak ETag to send back as `If-None-Match`, when the server gave one. */
  etag: string | undefined;
}

/**
 * Reads what changed since `query.updated_since`, sending `etag` as
 * `If-None-Match` so a quiet poll is answered with a bodiless 304.
 */
export const listIssueDelta = async (
  workspaceId: string,
  query: IssueListFilters & { updated_since: string },
  etag: string | undefined,
  signal?: AbortSignal
): Promise<IssueDeltaRead> => {
  const response = polledResponse(
    await apiClient.get<IssueListRead>(issuesPath(workspaceId), {
      ...listOptions({ ...query }, signal),
      ...(etag === undefined ? {} : { headers: { 'If-None-Match': etag } }),
    })
  );
  if (response.notModified) {
    return { page: null, etag: response.etag ?? etag };
  }
  return { page: readIssuePage(response.data), etag: response.etag };
};

/** Creates an issue. The key comes from the team counter, never the caller. */
export const createIssue = async (
  workspaceId: string,
  body: IssueCreate
): Promise<IssueRead> => {
  const response = await apiClient.post<IssueRead>(
    issuesPath(workspaceId),
    body
  );
  return response.data;
};

/** Reads one issue by id. */
export const getIssue = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<IssueRead> => {
  const response = await apiClient.get<IssueRead>(
    issuePath(workspaceId, issueId),
    signalOptions(signal)
  );
  return response.data;
};

/** Reads one issue by its key, which the contract matches case insensitively. */
export const getIssueByKey = async (
  workspaceId: string,
  key: string,
  signal?: AbortSignal
): Promise<IssueRead> => {
  const response = await apiClient.get<IssueRead>(
    issueByKeyPath(workspaceId, key),
    signalOptions(signal)
  );
  return response.data;
};

/** Updates an issue. Each changed field becomes one activity row server side. */
export const updateIssue = async (
  workspaceId: string,
  issueId: string,
  body: IssueOrderUpdate
): Promise<IssueRead> => {
  const response = await apiClient.patch<IssueRead>(
    issuePath(workspaceId, issueId),
    body
  );
  return response.data;
};

/**
 * Applies one patch to many issues. The server validates the whole batch
 * before writing any of it, so a 404, 403 or 422 means nothing changed.
 */
export const bulkUpdateIssues = async (
  workspaceId: string,
  body: IssueBulkUpdate
): Promise<IssueBulkRead> => {
  const response = await apiClient.patch<IssueBulkRead>(
    issuesPath(workspaceId),
    body
  );
  const data = response.data;
  return {
    issues: Array.isArray(data?.issues) ? data.issues : [],
    skipped: Array.isArray(data?.skipped) ? data.skipped : [],
  };
};

/** Deletes an issue. The server reparents its children rather than cascading. */
export const deleteIssue = async (
  workspaceId: string,
  issueId: string
): Promise<void> => {
  await apiClient.delete<void>(issuePath(workspaceId, issueId));
};

/**
 * Archives an issue, hiding it from lists and boards. It stays searchable,
 * opens by its key and can be restored. Archiving twice is a no-op.
 */
export const archiveIssue = async (
  workspaceId: string,
  issueId: string
): Promise<IssueRead> => {
  const response = await apiClient.post<IssueRead>(
    `${issuePath(workspaceId, issueId)}/archive`
  );
  return response.data;
};

/**
 * Moves an issue to another team. It answers the issue under its new key,
 * and the old key keeps resolving to it.
 */
export const moveIssue = async (
  workspaceId: string,
  issueId: string,
  teamId: string
): Promise<IssueRead> => {
  const body: IssueMove = { team_id: teamId };
  const response = await apiClient.post<IssueRead>(
    `${issuePath(workspaceId, issueId)}/move`,
    body
  );
  return response.data;
};

/** Restores an archived issue to its lists and board. */
export const unarchiveIssue = async (
  workspaceId: string,
  issueId: string
): Promise<IssueRead> => {
  const response = await apiClient.post<IssueRead>(
    `${issuePath(workspaceId, issueId)}/unarchive`
  );
  return response.data;
};

/** Lists an issue's direct children, which the route orders by creation. */
export const listChildren = async (
  workspaceId: string,
  issueId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<IssueListRead> => {
  const response = await apiClient.get<IssueListRead>(
    issueChildrenPath(workspaceId, issueId),
    listOptions({ ...query }, signal)
  );
  return readIssuePage(response.data);
};

/** Lists an issue's links. The route already folds in the inverse direction. */
export const listLinks = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<LinkRead[]> => {
  const response = await apiClient.get<LinkListRead>(
    issueLinksPath(workspaceId, issueId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.links) ? body.links : [];
};

/** Adds a link. The route is idempotent on the same pair and type. */
export const createLink = async (
  workspaceId: string,
  issueId: string,
  body: LinkCreate
): Promise<LinkRead> => {
  const response = await apiClient.post<LinkRead>(
    issueLinksPath(workspaceId, issueId),
    body
  );
  return response.data;
};

/** Removes a link, which drops the row on both issues. */
export const deleteLink = async (
  workspaceId: string,
  issueId: string,
  linkId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${issueLinksPath(workspaceId, issueId)}/${linkId}`
  );
};

/** Lists an issue's activity, newest first, one cursor page at a time. */
export const listActivity = async (
  workspaceId: string,
  issueId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<ActivityListRead> => {
  const response = await apiClient.get<ActivityListRead>(
    issueActivityPath(workspaceId, issueId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    activity: Array.isArray(body?.activity) ? body.activity : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** An empty page, for a query that is disabled before its ids are known. */
export const emptyPage = emptyIssuePage;

/** An empty activity page, used the same way as {@link emptyPage}. */
export const emptyActivityPage = (): ActivityListRead => ({
  activity: [],
  next_cursor: null,
});

/** Appends a cursor page to the rows already held, keeping their order. */
export const appendIssues = (
  held: IssueRead[],
  page: IssueListRead
): IssueRead[] => {
  const seen = new Set(held.map((issue) => issue.id));
  return [...held, ...page.issues.filter((issue) => !seen.has(issue.id))];
};

/** Appends an activity page to the entries already held. */
export const appendActivity = (
  held: ActivityRead[],
  page: ActivityListRead
): ActivityRead[] => {
  const seen = new Set(held.map((entry) => entry.activity_id));
  return [
    ...held,
    ...page.activity.filter((entry) => !seen.has(entry.activity_id)),
  ];
};

const EXPORT_IGNORED = new Set([
  'sort',
  'cursor',
  'limit',
  'updated_since',
  'subscriber_id',
]);

/**
 * The CSV of every issue the list filters select, following the export's cursor
 * to the end. The export takes the list's filters but keeps its own order, so
 * the list's sort and paging are left out.
 */
export const exportIssuesCsv = async (
  workspaceId: string,
  filters: IssueListFilters,
  signal?: AbortSignal
): Promise<string> => {
  const query: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!EXPORT_IGNORED.has(key) && value !== undefined) {
      query[key] = value as QueryValue;
    }
  }
  const pages: string[] = [];
  let cursor: string | null | undefined = null;
  for (;;) {
    const page: Record<string, QueryValue> = cursor
      ? { ...query, cursor }
      : query;
    const response = await apiClient.get<IssueExportRead>(
      issuesExportPath(workspaceId),
      listOptions(page, signal)
    );
    pages.push(response.data.csv);
    cursor = response.data.next_cursor;
    if (!cursor) return pages.join('');
  }
};
