/**
 * Connected apps: the OAuth clients, such as an MCP client, that a person has
 * authorized to act for them, and a workspace admin's view of every member's
 * grant. Revoking deletes the grant and ends the client's refresh tokens, so it
 * has to ask again before it can act.
 */

import apiClient from './client';
import type { ConnectedAppRead, WorkspaceConnectedAppRead } from '../types/Api';

/** The route the caller's own connected apps are listed on. */
export const MY_CONNECTED_APPS_ROUTE = '/users/me/connected-apps';

/** The route one of the caller's connected apps is revoked through. */
export const myConnectedAppPath = (clientId: string): string =>
  `${MY_CONNECTED_APPS_ROUTE}/${encodeURIComponent(clientId)}`;

/** The route a workspace's member grants are listed on. */
export const workspaceConnectedAppsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/connected-apps`;

/** The route one member's grant in a workspace is revoked through. */
export const workspaceConnectedAppPath = (
  workspaceId: string,
  userId: string,
  clientId: string
): string =>
  `${workspaceConnectedAppsPath(workspaceId)}/${encodeURIComponent(userId)}/${encodeURIComponent(clientId)}`;

/** Passes an abort signal through only when one was given. */
const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists the caller's connected apps, answering an empty list for a malformed body. */
export const listMyConnectedApps = async (
  signal?: AbortSignal
): Promise<ConnectedAppRead[]> => {
  const response = await apiClient.get<{ apps?: ConnectedAppRead[] }>(
    MY_CONNECTED_APPS_ROUTE,
    signalOptions(signal)
  );
  const apps = response.data?.apps;
  return Array.isArray(apps) ? apps : [];
};

/** Revokes the caller's grant to one client in every workspace. */
export const revokeMyConnectedApp = async (clientId: string): Promise<void> => {
  await apiClient.delete(myConnectedAppPath(clientId));
};

/** Lists every member's grant in a workspace. Refused to anyone but an admin. */
export const listWorkspaceConnectedApps = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<WorkspaceConnectedAppRead[]> => {
  const response = await apiClient.get<{ apps?: WorkspaceConnectedAppRead[] }>(
    workspaceConnectedAppsPath(workspaceId),
    signalOptions(signal)
  );
  const apps = response.data?.apps;
  return Array.isArray(apps) ? apps : [];
};

/** Revokes one member's grant to one client in this workspace only. */
export const revokeWorkspaceConnectedApp = async (
  workspaceId: string,
  userId: string,
  clientId: string
): Promise<void> => {
  await apiClient.delete(
    workspaceConnectedAppPath(workspaceId, userId, clientId)
  );
};
