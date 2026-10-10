/**
 * The workspace home route: one aggregate read for the landing page, so the
 * page draws from one request rather than a fan of list reads.
 */

import apiClient from './client';
import type { HomeFocusRead, HomeRead, HomeShippedRead } from '../types/Api';

/** The home route, under the views prefix the gateway already routes. */
export const homePath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/views/home`;

const EMPTY_FOCUS: HomeFocusRead = {
  open_count: 0,
  truncated: false,
  attention_count: 0,
  in_progress_count: 0,
  up_next_count: 0,
  attention: [],
  in_progress: [],
  up_next: [],
};

const list = <T>(value: T[] | undefined | null): T[] =>
  Array.isArray(value) ? value : [];

/** Reads the caller's home, with `tz` deciding what today is for due dates and cycles. */
export const getHome = async (
  workspaceId: string,
  tz: string,
  signal?: AbortSignal
): Promise<HomeRead> => {
  const response = await apiClient.get<HomeRead>(
    homePath(workspaceId),
    signal === undefined ? { query: { tz } } : { query: { tz }, signal }
  );
  const body = response.data;
  const focus = body?.focus ?? EMPTY_FOCUS;
  const shipped: HomeShippedRead = body?.shipped ?? {
    since: '',
    count: 0,
    mine: 0,
    items: [],
  };
  return {
    generated_at: body?.generated_at ?? '',
    today: body?.today ?? '',
    team_ids: list(body?.team_ids),
    focus: {
      ...EMPTY_FOCUS,
      ...focus,
      attention: list(focus.attention),
      in_progress: list(focus.in_progress),
      up_next: list(focus.up_next),
    },
    cycles: list(body?.cycles),
    projects: list(body?.projects),
    projects_total: body?.projects_total ?? 0,
    shipped: { ...shipped, items: list(shipped.items) },
    pulse: list(body?.pulse),
    inbox: {
      unread_count: body?.inbox?.unread_count ?? 0,
      items: list(body?.inbox?.items),
    },
    pull_requests: list(body?.pull_requests),
    releases: list(body?.releases),
  };
};

/** The caller's IANA timezone, or UTC where the runtime cannot say. */
export const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
