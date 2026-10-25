/**
 * The customer routes: the companies a workspace builds for and the requests
 * they make for issues and projects. A customer is reached by its own id, and a
 * request is filed and listed through the issue or project it names, listed
 * again under its customer, and edited, moved and removed through its customer.
 */

import apiClient from './client';
import type {
  CustomerCreate,
  CustomerFieldCreate,
  CustomerFieldRead,
  CustomerFieldUpdate,
  CustomerListRead,
  CustomerPatch,
  CustomerRead,
  CustomerRequestCreate,
  CustomerRequestListRead,
  CustomerRequestPatch,
  CustomerRequestRead,
  CustomerStatusListRead,
  CustomerTargetKind,
  CustomerTierListRead,
} from '../types/Api';

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

const requestRows = (
  body: CustomerRequestListRead | undefined
): CustomerRequestRead[] =>
  Array.isArray(body?.requests) ? body.requests : [];

/** The route the workspace's customers are listed and created on. */
export const customersApiPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/customers`;

/** The route every visible request of the workspace is listed on. */
export const workspaceCustomerRequestsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/customers/requests`;

/** The route one customer is read, edited and deleted through. */
export const customerApiPath = (
  workspaceId: string,
  customerId: string
): string => `/workspaces/${workspaceId}/customers/${customerId}`;

/** The route one customer is merged into another on. */
export const customerMergePath = (
  workspaceId: string,
  customerId: string
): string => `/workspaces/${workspaceId}/customers/${customerId}/merge`;

/** The route one customer's requests are listed on. */
export const customerRequestsPath = (
  workspaceId: string,
  customerId: string
): string => `/workspaces/${workspaceId}/customers/${customerId}/requests`;

/** The route one request is edited and removed through. */
export const customerRequestPath = (
  workspaceId: string,
  customerId: string,
  requestId: string
): string =>
  `/workspaces/${workspaceId}/customers/${customerId}/requests/${requestId}`;

/** The route one issue's customer requests are listed and filed on. */
export const issueCustomerRequestsPath = (
  workspaceId: string,
  issueId: string
): string => `/workspaces/${workspaceId}/issues/${issueId}/customer-requests`;

/** The route one project's customer requests are listed and filed on. */
export const projectCustomerRequestsPath = (
  workspaceId: string,
  projectId: string
): string =>
  `/workspaces/${workspaceId}/projects/${projectId}/customer-requests`;

/** The route a target's requests live on, by its kind. */
const targetPath = (
  workspaceId: string,
  kind: CustomerTargetKind,
  targetId: string
): string =>
  kind === 'issue'
    ? issueCustomerRequestsPath(workspaceId, targetId)
    : projectCustomerRequestsPath(workspaceId, targetId);

/** Lists every customer of the workspace, by name. */
export const listCustomers = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<CustomerRead[]> => {
  const response = await apiClient.get<CustomerListRead>(
    customersApiPath(workspaceId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.customers) ? body.customers : [];
};

/** Reads one customer with its visible request count. */
export const getCustomer = async (
  workspaceId: string,
  customerId: string,
  signal?: AbortSignal
): Promise<CustomerRead> => {
  const response = await apiClient.get<CustomerRead>(
    customerApiPath(workspaceId, customerId),
    signalOptions(signal)
  );
  return response.data;
};

/** Adds a customer. */
export const createCustomer = async (
  workspaceId: string,
  body: CustomerCreate
): Promise<CustomerRead> => {
  const response = await apiClient.post<CustomerRead>(
    customersApiPath(workspaceId),
    body
  );
  return response.data;
};

/** Edits a customer's fields. */
export const updateCustomer = async (
  workspaceId: string,
  customerId: string,
  body: CustomerPatch
): Promise<CustomerRead> => {
  const response = await apiClient.patch<CustomerRead>(
    customerApiPath(workspaceId, customerId),
    body
  );
  return response.data;
};

/** Deletes a customer with every request it made. */
export const deleteCustomer = async (
  workspaceId: string,
  customerId: string
): Promise<void> => {
  await apiClient.delete<void>(customerApiPath(workspaceId, customerId));
};

/** Folds one customer into another and answers the survivor. */
export const mergeCustomer = async (
  workspaceId: string,
  customerId: string,
  intoCustomerId: string
): Promise<CustomerRead> => {
  const response = await apiClient.post<CustomerRead>(
    customerMergePath(workspaceId, customerId),
    { into_customer_id: intoCustomerId }
  );
  return response.data;
};

/** Lists one customer's visible requests, newest first. */
export const listCustomerRequests = async (
  workspaceId: string,
  customerId: string,
  signal?: AbortSignal
): Promise<CustomerRequestRead[]> => {
  const response = await apiClient.get<CustomerRequestListRead>(
    customerRequestsPath(workspaceId, customerId),
    signalOptions(signal)
  );
  return requestRows(response.data);
};

/** Lists every request the caller can see across customers, newest first. */
export const listWorkspaceRequests = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<CustomerRequestRead[]> => {
  const response = await apiClient.get<CustomerRequestListRead>(
    workspaceCustomerRequestsPath(workspaceId),
    signalOptions(signal)
  );
  return requestRows(response.data);
};

/** Lists the requests naming one issue or project, newest first. */
export const listTargetRequests = async (
  workspaceId: string,
  kind: CustomerTargetKind,
  targetId: string,
  signal?: AbortSignal
): Promise<CustomerRequestRead[]> => {
  const response = await apiClient.get<CustomerRequestListRead>(
    targetPath(workspaceId, kind, targetId),
    signalOptions(signal)
  );
  return requestRows(response.data);
};

/** Files a customer's request for an issue or a project. */
export const createCustomerRequest = async (
  workspaceId: string,
  kind: CustomerTargetKind,
  targetId: string,
  body: CustomerRequestCreate
): Promise<CustomerRequestRead> => {
  const response = await apiClient.post<CustomerRequestRead>(
    targetPath(workspaceId, kind, targetId),
    body
  );
  return response.data;
};

/** Edits one request's quote, customer or important flag, or moves it to another target. */
export const updateCustomerRequest = async (
  workspaceId: string,
  customerId: string,
  requestId: string,
  body: CustomerRequestPatch
): Promise<CustomerRequestRead> => {
  const response = await apiClient.patch<CustomerRequestRead>(
    customerRequestPath(workspaceId, customerId, requestId),
    body
  );
  return response.data;
};

/** Removes one request. */
export const deleteCustomerRequest = async (
  workspaceId: string,
  customerId: string,
  requestId: string
): Promise<void> => {
  await apiClient.delete<void>(
    customerRequestPath(workspaceId, customerId, requestId)
  );
};

/** The two lists a workspace admin sets up for its customers. */
export type CustomerFieldKind = 'statuses' | 'tiers';

/** The route the workspace's customer statuses are read and added to on. */
export const customerStatusesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/customers/statuses`;

/** The route the workspace's customer tiers are read and added to on. */
export const customerTiersPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/customers/tiers`;

/** The route one customer status is edited and deleted on. */
export const customerStatusPath = (
  workspaceId: string,
  statusId: string
): string => `${customerStatusesPath(workspaceId)}/${statusId}`;

/** The route one customer tier is edited and deleted on. */
export const customerTierPath = (workspaceId: string, tierId: string): string =>
  `${customerTiersPath(workspaceId)}/${tierId}`;

/** Lists the workspace's customer statuses or tiers, by position. */
export const listCustomerFields = async (
  workspaceId: string,
  kind: CustomerFieldKind,
  signal?: AbortSignal
): Promise<CustomerFieldRead[]> => {
  if (kind === 'statuses') {
    const response = await apiClient.get<CustomerStatusListRead>(
      customerStatusesPath(workspaceId),
      signalOptions(signal)
    );
    const rows = response.data?.statuses;
    return Array.isArray(rows) ? rows : [];
  }
  const response = await apiClient.get<CustomerTierListRead>(
    customerTiersPath(workspaceId),
    signalOptions(signal)
  );
  const rows = response.data?.tiers;
  return Array.isArray(rows) ? rows : [];
};

/** Adds a customer status or tier; an admin only. */
export const createCustomerField = async (
  workspaceId: string,
  kind: CustomerFieldKind,
  body: CustomerFieldCreate
): Promise<CustomerFieldRead> => {
  const response =
    kind === 'statuses'
      ? await apiClient.post<CustomerFieldRead>(
          customerStatusesPath(workspaceId),
          body
        )
      : await apiClient.post<CustomerFieldRead>(
          customerTiersPath(workspaceId),
          body
        );
  return response.data;
};

/** Renames, recolours or moves a customer status or tier; an admin only. */
export const updateCustomerField = async (
  workspaceId: string,
  kind: CustomerFieldKind,
  fieldId: string,
  body: CustomerFieldUpdate
): Promise<CustomerFieldRead> => {
  const response =
    kind === 'statuses'
      ? await apiClient.patch<CustomerFieldRead>(
          customerStatusPath(workspaceId, fieldId),
          body
        )
      : await apiClient.patch<CustomerFieldRead>(
          customerTierPath(workspaceId, fieldId),
          body
        );
  return response.data;
};

/**
 * Deletes a customer status or tier, moving the customers that hold it to
 * `replacementId`. One customers hold is refused without a replacement.
 */
export const deleteCustomerField = async (
  workspaceId: string,
  kind: CustomerFieldKind,
  fieldId: string,
  replacementId?: string
): Promise<void> => {
  const options =
    replacementId === undefined
      ? undefined
      : { query: { replacement_id: replacementId } };
  if (kind === 'statuses') {
    await apiClient.delete<void>(
      customerStatusPath(workspaceId, fieldId),
      options
    );
    return;
  }
  await apiClient.delete<void>(customerTierPath(workspaceId, fieldId), options);
};
