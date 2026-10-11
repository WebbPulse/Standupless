/**
 * The personal notification routes: who follows an issue, the caller's own
 * subscribe and unsubscribe, and the caller's notification preferences.
 *
 * Preferences belong to the person rather than to a workspace, so they are
 * read from and written to the identity profile route and apply everywhere the
 * person is a member.
 */

import apiClient from './client';
import { issuePath } from './issues';
import type {
  NotificationKind,
  SubscribersRead,
  UserPreferencesUpdate,
  UserRead,
} from '../types/Api';

/** The kinds of notification a person can switch, in the order settings lists them. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'assigned',
  'mentioned',
  'commented',
  'status_changed',
  'subscribed',
  'project_update',
  'project_update_due',
  'due_soon',
  'overdue',
  'standup_digest',
  'sla_at_risk',
  'sla_breached',
  'review_requested',
];

/** The route an issue's subscribers are read from. */
export const issueSubscribersPath = (
  workspaceId: string,
  issueId: string
): string => `${issuePath(workspaceId, issueId)}/subscribers`;

/** Who a subscribe or unsubscribe acts on when no person is named. */
export const ME = 'me';

/** The route one person is subscribed and unsubscribed through, `me` by default. */
export const subscriptionPath = (
  workspaceId: string,
  issueId: string,
  userId: string = ME
): string =>
  `${issueSubscribersPath(workspaceId, issueId)}/${encodeURIComponent(userId)}`;

/** The route the caller's own profile is read from. */
export const CURRENT_USER_ROUTE = '/users/me';

/** The route the caller's preferences are changed through. */
export const PREFERENCES_ROUTE = '/users/me/preferences';

/** Passes an abort signal through only when one was given. */
const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists an issue's subscribers and whether the caller is one of them. */
export const listSubscribers = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<SubscribersRead> => {
  const response = await apiClient.get<SubscribersRead>(
    issueSubscribersPath(workspaceId, issueId),
    signalOptions(signal)
  );
  return response.data;
};

/**
 * Subscribes the caller, or the named teammate, to an issue. Subscribing twice
 * keeps the first subscription.
 */
export const subscribe = async (
  workspaceId: string,
  issueId: string,
  userId: string = ME
): Promise<SubscribersRead> => {
  const response = await apiClient.put<SubscribersRead>(
    subscriptionPath(workspaceId, issueId, userId)
  );
  return response.data;
};

/**
 * Unsubscribes the caller, or the named teammate, from an issue. Unsubscribing
 * twice is not an error.
 */
export const unsubscribe = async (
  workspaceId: string,
  issueId: string,
  userId: string = ME
): Promise<SubscribersRead> => {
  const response = await apiClient.delete<SubscribersRead>(
    subscriptionPath(workspaceId, issueId, userId)
  );
  return response.data;
};

/** Reads the caller's own profile, which carries their notification preferences. */
export const getCurrentUser = async (
  signal?: AbortSignal
): Promise<UserRead> => {
  const response = await apiClient.get<UserRead>(
    CURRENT_USER_ROUTE,
    signalOptions(signal)
  );
  return response.data;
};

/** Applies a partial preferences change and returns the profile as stored. */
export const updatePreferences = async (
  body: UserPreferencesUpdate
): Promise<UserRead> => {
  const response = await apiClient.patch<UserRead>(PREFERENCES_ROUTE, body);
  return response.data;
};
