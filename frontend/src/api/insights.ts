/**
 * The insights route: a breakdown of the issues a scope and filter select.
 * It takes the issue list's filters with the same meaning, so the panel sends
 * the very query the list beside it runs.
 */

import apiClient from './client';
import type { IssueListFilters } from './issues';
import type {
  InsightDimension,
  InsightMeasure,
  InsightsRead,
} from '../types/Api';

/** The breakdown asked for, on top of the list filters. */
export type InsightsQuery = Omit<IssueListFilters, 'sort'> & {
  group_by: InsightDimension;
  segment_by?: InsightDimension;
  measure?: InsightMeasure;
  view_id?: string;
};

/** The insights route, under the views prefix the gateway already routes. */
export const insightsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/views/insights`;

/** A breakdown body with the fields an older server might omit filled in. */
export const normalizeInsights = (
  body: Partial<InsightsRead> | null | undefined,
  groupBy: InsightDimension
): InsightsRead => ({
  team_ids: Array.isArray(body?.team_ids) ? body.team_ids : [],
  view_id: body?.view_id ?? null,
  group_by: body?.group_by ?? groupBy,
  segment_by: body?.segment_by ?? null,
  measure: body?.measure ?? 'count',
  total: body?.total ?? 0,
  issue_count: body?.issue_count ?? 0,
  groups: Array.isArray(body?.groups) ? body.groups : [],
  truncated: body?.truncated === true,
  row_cap: body?.row_cap ?? 0,
  durations: body?.durations ?? null,
  points: Array.isArray(body?.points) ? body.points : [],
});

/** Reads one breakdown, filling the fields an older server might omit. */
export const getInsights = async (
  workspaceId: string,
  query: InsightsQuery,
  signal?: AbortSignal
): Promise<InsightsRead> => {
  const response = await apiClient.get<InsightsRead>(
    insightsPath(workspaceId),
    signal === undefined
      ? { query: { ...query } }
      : { query: { ...query }, signal }
  );
  return normalizeInsights(response.data, query.group_by);
};
