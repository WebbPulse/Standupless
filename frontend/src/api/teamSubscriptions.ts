/**
 * The routes behind a person's own team notifications: which of a team's new,
 * triaged, completed and cancelled issues land in their inbox.
 */

import apiClient from './client';
import type {
  TeamNotificationSubscriptionRead,
  TeamNotificationSubscriptionUpdate,
} from '../types/Api';

/** The route the caller's subscription to one team is read and changed at. */
export const teamSubscriptionPath = (
  workspaceId: string,
  teamId: string
): string => `/workspaces/${workspaceId}/views/teams/${teamId}/subscription`;

/** The caller's subscription to a team; every event is off until turned on. */
export const getTeamSubscription = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TeamNotificationSubscriptionRead> => {
  const response = await apiClient.get<TeamNotificationSubscriptionRead>(
    teamSubscriptionPath(workspaceId, teamId),
    signal === undefined ? undefined : { signal }
  );
  return response.data;
};

/** Turns team events on or off for the caller; omitted events keep their value. */
export const updateTeamSubscription = async (
  workspaceId: string,
  teamId: string,
  body: TeamNotificationSubscriptionUpdate
): Promise<TeamNotificationSubscriptionRead> => {
  const response = await apiClient.put<TeamNotificationSubscriptionRead>(
    teamSubscriptionPath(workspaceId, teamId),
    body
  );
  return response.data;
};
