/**
 * The billing routes: the plan read, the pooled storage read, and the two
 * calls that hand the browser to a hosted Stripe page. Checkout and the portal
 * answer only a URL; the plan itself changes when Stripe's webhook lands.
 */

import apiClient from './client';
import { workspacePath } from './workspaces';
import type {
  BillingRead,
  BillingSessionRead,
  CheckoutCreate,
  StorageUsageRead,
} from '../types/Api';

/** The route a workspace's plan is read from. */
export const billingPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/billing`;

/** The route a Checkout Session is started at. */
export const checkoutSessionPath = (workspaceId: string): string =>
  `${billingPath(workspaceId)}/checkout-session`;

/** The route a Customer Portal session is opened at. */
export const portalSessionPath = (workspaceId: string): string =>
  `${billingPath(workspaceId)}/portal-session`;

/** The route a workspace's pooled attachment storage is read from. */
export const storageUsagePath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/attachments/usage`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Reads the workspace's plan, subscription and what the plan grants. */
export const getBilling = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<BillingRead> => {
  const response = await apiClient.get<BillingRead>(
    billingPath(workspaceId),
    signalOptions(signal)
  );
  return response.data;
};

/** Reads how much of its plan's storage the workspace's uploads hold. */
export const getStorageUsage = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<StorageUsageRead> => {
  const response = await apiClient.get<StorageUsageRead>(
    storageUsagePath(workspaceId),
    signalOptions(signal)
  );
  return response.data;
};

/** Starts a Stripe Checkout for a paid plan and answers its URL. Admin only. */
export const createCheckoutSession = async (
  workspaceId: string,
  body: CheckoutCreate
): Promise<string> => {
  const response = await apiClient.post<BillingSessionRead>(
    checkoutSessionPath(workspaceId),
    body
  );
  return response.data.url;
};

/** Opens the Stripe Customer Portal and answers its URL. Admin only. */
export const createPortalSession = async (
  workspaceId: string
): Promise<string> => {
  const response = await apiClient.post<BillingSessionRead>(
    portalSessionPath(workspaceId)
  );
  return response.data.url;
};
