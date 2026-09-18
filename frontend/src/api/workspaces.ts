/**
 * The workspace routes: the tenant root, its members and its invites. Every
 * list read unwraps the plural envelope the contract fixes, answering an empty
 * list rather than throwing when the array is missing, so a malformed body
 * cannot blank a page.
 */

import apiClient from './client';
import type {
  InviteCreate,
  InviteCreatedRead,
  InviteListRead,
  InviteRead,
  MemberListRead,
  MemberRead,
  MemberUpdate,
  WorkspaceCreate,
  WorkspaceListRead,
  WorkspaceRead,
  WorkspaceUpdate,
} from '../types/Api';

/** The route the workspace list is read from. */
export const WORKSPACES_PATH = '/workspaces';

/** The route an invite is redeemed at. */
export const INVITE_ACCEPT_PATH = '/invites/accept';

/** The route one workspace is read from. */
export const workspacePath = (workspaceId: string): string =>
  `${WORKSPACES_PATH}/${workspaceId}`;

/** The route a workspace's members are read from. */
export const membersPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/members`;

/** The route a workspace's invites are read from. */
export const invitesPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/invites`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists the caller's workspaces, reading the items out of the envelope. */
export const listWorkspaces = async (
  signal?: AbortSignal
): Promise<WorkspaceRead[]> => {
  const response = await apiClient.get<WorkspaceListRead>(
    WORKSPACES_PATH,
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.workspaces) ? body.workspaces : [];
};

/** Creates a workspace. The caller becomes its owner. */
export const createWorkspace = async (
  body: WorkspaceCreate
): Promise<WorkspaceRead> => {
  const response = await apiClient.post<WorkspaceRead>(WORKSPACES_PATH, body);
  return response.data;
};

/** Reads one workspace. */
export const getWorkspace = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<WorkspaceRead> => {
  const response = await apiClient.get<WorkspaceRead>(
    workspacePath(workspaceId),
    signalOptions(signal)
  );
  return response.data;
};

/** Renames a workspace. */
export const updateWorkspace = async (
  workspaceId: string,
  body: WorkspaceUpdate
): Promise<WorkspaceRead> => {
  const response = await apiClient.patch<WorkspaceRead>(
    workspacePath(workspaceId),
    body
  );
  return response.data;
};

/** Deletes a workspace. Owner only. */
export const deleteWorkspace = async (workspaceId: string): Promise<void> => {
  await apiClient.delete<void>(workspacePath(workspaceId));
};

/** Lists a workspace's members. */
export const listMembers = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<MemberRead[]> => {
  const response = await apiClient.get<MemberListRead>(
    membersPath(workspaceId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.members) ? body.members : [];
};

/** Changes one member's role. */
export const updateMember = async (
  workspaceId: string,
  userId: string,
  body: MemberUpdate
): Promise<MemberRead> => {
  const response = await apiClient.patch<MemberRead>(
    `${membersPath(workspaceId)}/${userId}`,
    body
  );
  return response.data;
};

/** Removes one member. The API refuses to remove the last owner. */
export const removeMember = async (
  workspaceId: string,
  userId: string
): Promise<void> => {
  await apiClient.delete<void>(`${membersPath(workspaceId)}/${userId}`);
};

/** Lists a workspace's outstanding invites. */
export const listInvites = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<InviteRead[]> => {
  const response = await apiClient.get<InviteListRead>(
    invitesPath(workspaceId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.invites) ? body.invites : [];
};

/**
 * Creates an invite. The response carries the token once and it is never
 * readable again, so the caller must surface it immediately.
 */
export const createInvite = async (
  workspaceId: string,
  body: InviteCreate
): Promise<InviteCreatedRead> => {
  const response = await apiClient.post<InviteCreatedRead>(
    invitesPath(workspaceId),
    body
  );
  return response.data;
};

/** Revokes an outstanding invite. */
export const revokeInvite = async (
  workspaceId: string,
  inviteId: string
): Promise<void> => {
  await apiClient.delete<void>(`${invitesPath(workspaceId)}/${inviteId}`);
};

/** Redeems an invite token. Idempotent for a user who is already a member. */
export const acceptInvite = async (token: string): Promise<MemberRead> => {
  const response = await apiClient.post<MemberRead>(INVITE_ACCEPT_PATH, {
    token,
  });
  return response.data;
};
