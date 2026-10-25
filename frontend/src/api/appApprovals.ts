/**
 * Third-party app approvals. With a workspace's approval setting on, a member
 * consenting to an app the workspace has not approved lands on a request page
 * instead, holding a signed ticket naming the app. They send the request from
 * there, and an admin approves, denies or revokes it from connected apps
 * settings. Revoking marks the app denied and then removes every member's grant
 * to it, so a revoked app can neither refresh nor be authorized again until an
 * admin approves it.
 */

import apiClient from './client';
import { revokeWorkspaceApp } from './connectedApps';
import type {
  AppAccessRequestRead,
  AppApprovalListRead,
  AppApprovalRead,
  AppApprovalStatus,
} from '../types/Api';

/** The route a workspace's approval records are listed on. */
export const appApprovalsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/app-approvals`;

/** The route one app's approval records under, which its decisions are posted beneath. */
export const appApprovalPath = (
  workspaceId: string,
  clientId: string
): string => `${appApprovalsPath(workspaceId)}/${encodeURIComponent(clientId)}`;

/** Passes an abort signal through only when one was given. */
const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists a workspace's approval records, optionally of one status. Refused to anyone but an admin. */
export const listAppApprovals = async (
  workspaceId: string,
  status?: AppApprovalStatus,
  signal?: AbortSignal
): Promise<AppApprovalListRead> => {
  const response = await apiClient.get<AppApprovalListRead>(
    appApprovalsPath(workspaceId),
    {
      ...(status === undefined ? {} : { params: { status } }),
      ...signalOptions(signal),
    }
  );
  const data = response.data;
  return {
    enabled: data?.enabled === true,
    approvals: Array.isArray(data?.approvals) ? data.approvals : [],
  };
};

/** Reads what the request page shows for the app a ticket names. */
export const getAppAccessRequest = async (
  workspaceId: string,
  ticket: string,
  signal?: AbortSignal
): Promise<AppAccessRequestRead> => {
  const response = await apiClient.get<AppAccessRequestRead>(
    `${appApprovalsPath(workspaceId)}/request`,
    { params: { ticket }, ...signalOptions(signal) }
  );
  return response.data;
};

/** Asks the workspace's admins to approve the app a ticket names. */
export const requestAppAccess = async (
  workspaceId: string,
  ticket: string,
  reason: string
): Promise<AppApprovalRead> => {
  const response = await apiClient.post<AppApprovalRead>(
    `${appApprovalsPath(workspaceId)}/requests`,
    { ticket, reason }
  );
  return response.data;
};

/** Records an admin's approval or denial of an app, with an optional reason. */
export const decideAppApproval = async (
  workspaceId: string,
  clientId: string,
  decision: 'approve' | 'deny',
  reason: string,
  clientName: string
): Promise<AppApprovalRead> => {
  const body = { reason, client_name: clientName };
  const response =
    decision === 'approve'
      ? await apiClient.post<AppApprovalRead>(
          `${appApprovalPath(workspaceId, clientId)}/approve`,
          body
        )
      : await apiClient.post<AppApprovalRead>(
          `${appApprovalPath(workspaceId, clientId)}/deny`,
          body
        );
  return response.data;
};

/** Marks an app denied, then removes every member's grant to it in this workspace. */
export const revokeAppApproval = async (
  workspaceId: string,
  clientId: string,
  reason: string,
  clientName: string
): Promise<AppApprovalRead> => {
  const response = await apiClient.post<AppApprovalRead>(
    `${appApprovalPath(workspaceId, clientId)}/revoke`,
    { reason, client_name: clientName }
  );
  await revokeWorkspaceApp(workspaceId, clientId);
  return response.data;
};
