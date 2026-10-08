/**
 * The workspace routes: the tenant root, its members and its invites. Every
 * list read unwraps the plural envelope the contract fixes, answering an empty
 * list rather than throwing when the array is missing, so a malformed body
 * cannot blank a page.
 */

import apiClient from './client';
import type {
  ApprovedDomainListRead,
  ApprovedDomainRead,
  AuditLogFilters,
  AuditLogRead,
  AuthPolicyRead,
  AuthPolicyUpdate,
  InviteCreate,
  InviteCreatedRead,
  InviteListRead,
  InviteRead,
  JoinableWorkspaceListRead,
  JoinableWorkspaceRead,
  MemberListRead,
  MemberRead,
  MemberUpdate,
  WorkspaceCreate,
  WorkspaceDeletionRequest,
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

/** The route a workspace's deletion is scheduled and cancelled through. */
export const workspaceDeletionPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/deletion`;

/** The route a workspace's members are read from. */
export const membersPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/members`;

/** The route a workspace's authentication policy is read and set through. */
export const authPolicyPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/auth-policy`;

/** The route a workspace's approved email domains are read and added through. */
export const approvedDomainsPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/approved-domains`;

/** The route one approved email domain is removed through. */
export const approvedDomainPath = (
  workspaceId: string,
  domain: string
): string =>
  `${approvedDomainsPath(workspaceId)}/${encodeURIComponent(domain)}`;

/** The route a workspace is joined through by an approved email domain. */
export const joinWorkspacePath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/join`;

/** The route the workspaces the caller may join by email domain are read from. */
export const JOINABLE_WORKSPACES_PATH = '/workspaces/joinable';

/** The route a workspace's audit log is read from. */
export const auditLogPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/audit-log`;

/** The route a workspace's invites are read from. */
export const invitesPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/invites`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

type AuditQuery = Record<string, string | number | undefined>;

/** The set filters as a query, leaving out the empty ones so the server sees no blank filter. */
const auditQuery = (filters: AuditLogFilters): AuditQuery => {
  const query: AuditQuery = {};
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value !== '') query[key] = value;
  }
  return query;
};

/**
 * Reads one page of a workspace's audit log, newest first. Owner or admin only;
 * a plan without the audit log answers `available: false` and no events.
 */
export const listAuditLog = async (
  workspaceId: string,
  filters: AuditLogFilters,
  cursor?: string,
  signal?: AbortSignal
): Promise<AuditLogRead> => {
  const query = auditQuery(filters);
  if (cursor !== undefined) query.cursor = cursor;
  const response = await apiClient.get<AuditLogRead>(
    auditLogPath(workspaceId),
    signal === undefined ? { query } : { query, signal }
  );
  return {
    ...response.data,
    events: Array.isArray(response.data?.events) ? response.data.events : [],
    event_types: Array.isArray(response.data?.event_types)
      ? response.data.event_types
      : [],
  };
};

/** The CSV of every audit event the filters select, as the server writes it. */
export const exportAuditLogCsv = async (
  workspaceId: string,
  filters: AuditLogFilters
): Promise<string> => {
  const response = await apiClient.get<string>(
    `${auditLogPath(workspaceId)}/export`,
    { query: auditQuery(filters) }
  );
  return typeof response.data === 'string' ? response.data : '';
};

/** Reads a workspace's authentication policy. Owner or admin only. */
export const getAuthPolicy = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<AuthPolicyRead> => {
  const response = await apiClient.get<AuthPolicyRead>(
    authPolicyPath(workspaceId),
    signalOptions(signal)
  );
  return response.data;
};

/**
 * Requires two-factor authentication of every member, or stops requiring it.
 * Turning it on needs the Business plan and a second factor on the caller's
 * own account.
 */
export const updateAuthPolicy = async (
  workspaceId: string,
  body: AuthPolicyUpdate
): Promise<AuthPolicyRead> => {
  const response = await apiClient.put<AuthPolicyRead>(
    authPolicyPath(workspaceId),
    body
  );
  return response.data;
};

/** Lists a workspace's approved email domains. Owner or admin only. */
export const listApprovedDomains = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<ApprovedDomainRead[]> => {
  const response = await apiClient.get<ApprovedDomainListRead>(
    approvedDomainsPath(workspaceId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.domains) ? body.domains : [];
};

/**
 * Approves an email domain, so verified addresses on it may join without an
 * invite. It must be the caller's own verified domain and not a public provider.
 */
export const addApprovedDomain = async (
  workspaceId: string,
  domain: string
): Promise<ApprovedDomainRead> => {
  const response = await apiClient.post<ApprovedDomainRead>(
    approvedDomainsPath(workspaceId),
    { domain }
  );
  return response.data;
};

/** Stops approving an email domain. People who joined through it stay. */
export const removeApprovedDomain = async (
  workspaceId: string,
  domain: string
): Promise<void> => {
  await apiClient.delete<void>(approvedDomainPath(workspaceId, domain));
};

/** Lists the workspaces the caller's verified email domain lets them join. */
export const listJoinableWorkspaces = async (
  signal?: AbortSignal
): Promise<JoinableWorkspaceRead[]> => {
  const response = await apiClient.get<JoinableWorkspaceListRead>(
    JOINABLE_WORKSPACES_PATH,
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.workspaces) ? body.workspaces : [];
};

/** Joins a workspace as a member through an approved email domain. */
export const joinWorkspace = async (
  workspaceId: string
): Promise<MemberRead> => {
  const response = await apiClient.post<MemberRead>(
    joinWorkspacePath(workspaceId)
  );
  return response.data;
};

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

/**
 * Schedules a workspace's permanent deletion at the end of its grace period.
 * Owner or admin only, and the name has to be typed out again. Asking twice
 * keeps the first date.
 */
export const scheduleWorkspaceDeletion = async (
  workspaceId: string,
  body: WorkspaceDeletionRequest
): Promise<WorkspaceRead> => {
  const response = await apiClient.post<WorkspaceRead>(
    workspaceDeletionPath(workspaceId),
    body
  );
  return response.data;
};

/** Cancels a scheduled workspace deletion. Cancelling twice is a no-op. */
export const cancelWorkspaceDeletion = async (
  workspaceId: string
): Promise<WorkspaceRead> => {
  const response = await apiClient.delete<WorkspaceRead>(
    workspaceDeletionPath(workspaceId)
  );
  return response.data;
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
