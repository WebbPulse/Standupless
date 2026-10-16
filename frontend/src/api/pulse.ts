/**
 * The Pulse routes: the caller's feed of project and initiative updates, its
 * unread count and read marker, and the follows that decide what reaches it.
 *
 * Every route reads as the caller, so none take another person's id. The
 * follow routes are spelled out rather than built on the planning helpers, so
 * a page test that mocks those modules still reaches these.
 */

import apiClient from './client';
import type {
  PulseCountRead,
  PulseFollowRead,
  PulseListRead,
  PulseReadMarker,
  PulseScope,
} from '../types/Api';

/** The route the caller's Pulse is read from. */
export const pulseRoute = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/pulse`;

/** The route the Pulse unread count is read from. */
export const pulseCountRoute = (workspaceId: string): string =>
  `${pulseRoute(workspaceId)}/count`;

/** The route the caller marks their Pulse read through. */
export const pulseReadRoute = (workspaceId: string): string =>
  `${pulseRoute(workspaceId)}/read`;

/** The route the caller follows and unfollows a project through. */
export const projectFollowRoute = (
  workspaceId: string,
  projectId: string
): string => `/workspaces/${workspaceId}/projects/${projectId}/follow`;

/** The route the caller follows and unfollows an initiative through. */
export const initiativeFollowRoute = (
  workspaceId: string,
  initiativeId: string
): string => `/workspaces/${workspaceId}/initiatives/${initiativeId}/follow`;

/** What a Pulse page read asks for. */
export interface PulseQuery {
  scope?: PulseScope;
  cursor?: string;
  limit?: number;
}

/** What a project or initiative follow is about. */
export type FollowSubject = 'project' | 'initiative';

/** Reads one page of the caller's Pulse, newest first; a missing body reads as empty. */
export const listPulse = async (
  workspaceId: string,
  query: PulseQuery = {},
  signal?: AbortSignal
): Promise<PulseListRead> => {
  const bag: Record<string, string | number | undefined> = { ...query };
  const response = await apiClient.get<PulseListRead>(
    pulseRoute(workspaceId),
    signal === undefined ? { query: bag } : { query: bag, signal }
  );
  const body = response.data;
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** Reads how many entries of the caller's Pulse are unread, for the sidebar badge. */
export const getPulseCount = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<number> => {
  const response = await apiClient.get<PulseCountRead>(
    pulseCountRoute(workspaceId),
    signal === undefined ? undefined : { signal }
  );
  return response.data?.unread ?? 0;
};

/** Marks the caller's whole Pulse read as of now. */
export const markPulseRead = async (
  workspaceId: string
): Promise<PulseReadMarker> => {
  const response = await apiClient.post<PulseReadMarker>(
    pulseReadRoute(workspaceId)
  );
  return response.data;
};

/** Reads whether the caller follows a project or initiative. */
export const getFollow = async (
  workspaceId: string,
  subject: FollowSubject,
  subjectId: string,
  signal?: AbortSignal
): Promise<PulseFollowRead> => {
  const options = signal === undefined ? undefined : { signal };
  const response =
    subject === 'project'
      ? await apiClient.get<PulseFollowRead>(
          projectFollowRoute(workspaceId, subjectId),
          options
        )
      : await apiClient.get<PulseFollowRead>(
          initiativeFollowRoute(workspaceId, subjectId),
          options
        );
  return response.data;
};

/** Follows a project or initiative, answering the new state. */
const follow = async (
  workspaceId: string,
  subject: FollowSubject,
  subjectId: string
): Promise<PulseFollowRead> => {
  const response =
    subject === 'project'
      ? await apiClient.put<PulseFollowRead>(
          projectFollowRoute(workspaceId, subjectId)
        )
      : await apiClient.put<PulseFollowRead>(
          initiativeFollowRoute(workspaceId, subjectId)
        );
  return response.data;
};

/** Unfollows a project or initiative, answering the new state. */
const unfollow = async (
  workspaceId: string,
  subject: FollowSubject,
  subjectId: string
): Promise<PulseFollowRead> => {
  const response =
    subject === 'project'
      ? await apiClient.delete<PulseFollowRead>(
          projectFollowRoute(workspaceId, subjectId)
        )
      : await apiClient.delete<PulseFollowRead>(
          initiativeFollowRoute(workspaceId, subjectId)
        );
  return response.data;
};

/** Follows or unfollows a project or initiative, answering the new state. */
export const setFollow = (
  workspaceId: string,
  subject: FollowSubject,
  subjectId: string,
  following: boolean
): Promise<PulseFollowRead> =>
  following
    ? follow(workspaceId, subject, subjectId)
    : unfollow(workspaceId, subject, subjectId);
