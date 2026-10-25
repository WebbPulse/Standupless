/**
 * The member page reads: one member's profile and their recent activity,
 * under the views prefix the gateway already routes. Either read accepts
 * `me` for the caller.
 */

import apiClient from './client';
import type { MemberActivityListRead, MemberProfileRead } from '../types/Api';

/** The member's profile route. */
export const memberProfilePath = (
  workspaceId: string,
  userId: string
): string => `/workspaces/${workspaceId}/views/members/${userId}`;

/** The member's activity route. */
export const memberActivityPath = (
  workspaceId: string,
  userId: string
): string => `${memberProfilePath(workspaceId, userId)}/activity`;

/** Paging for the activity feed. */
export interface MemberActivityQuery {
  cursor?: string;
  limit?: number;
}

/** Reads one member's profile, answering 404 for someone outside the workspace. */
export const getMemberProfile = async (
  workspaceId: string,
  userId: string,
  signal?: AbortSignal
): Promise<MemberProfileRead> => {
  const response = await apiClient.get<MemberProfileRead>(
    memberProfilePath(workspaceId, userId),
    signal === undefined ? undefined : { signal }
  );
  return { ...response.data, team_ids: response.data?.team_ids ?? [] };
};

/** Reads one page of a member's activity, newest first. */
export const listMemberActivity = async (
  workspaceId: string,
  userId: string,
  query: MemberActivityQuery = {},
  signal?: AbortSignal
): Promise<MemberActivityListRead> => {
  const bag: Record<string, string | number> = { ...query };
  const response = await apiClient.get<MemberActivityListRead>(
    memberActivityPath(workspaceId, userId),
    signal === undefined ? { query: bag } : { query: bag, signal }
  );
  const body = response.data;
  return {
    activity: Array.isArray(body?.activity) ? body.activity : [],
    next_cursor: body?.next_cursor ?? null,
  };
};
