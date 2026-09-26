/**
 * The caller's own account deletion: the plan that says what it would do to
 * each workspace, and the schedule and cancel calls. Kept apart from the
 * notification routes because these change the account rather than its
 * preferences.
 */

import apiClient from './client';
import type {
  AccountDeletionPlanRead,
  AccountDeletionRequest,
  UserRead,
} from '../types/Api';

/** The route the caller's account deletion is scheduled and cancelled through. */
export const ACCOUNT_DELETION_ROUTE = '/users/me/deletion';

/** The route the caller's account deletion plan is read from. */
export const ACCOUNT_DELETION_PLAN_ROUTE = '/users/me/deletion-plan';

/** Passes an abort signal through only when one was given. */
const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Reads what deleting the account would do, answering empty lists for a malformed body. */
export const getAccountDeletionPlan = async (
  signal?: AbortSignal
): Promise<AccountDeletionPlanRead> => {
  const response = await apiClient.get<AccountDeletionPlanRead>(
    ACCOUNT_DELETION_PLAN_ROUTE,
    signalOptions(signal)
  );
  const body = response.data;
  return {
    blocking: Array.isArray(body?.blocking) ? body.blocking : [],
    deleted_with_account: Array.isArray(body?.deleted_with_account)
      ? body.deleted_with_account
      : [],
    leaving: Array.isArray(body?.leaving) ? body.leaving : [],
  };
};

/**
 * Schedules the account's permanent deletion at the end of its grace period,
 * with the address typed out again. Refused while the caller is the only owner
 * of a workspace other people still use.
 */
export const scheduleAccountDeletion = async (
  body: AccountDeletionRequest
): Promise<UserRead> => {
  const response = await apiClient.post<UserRead>(ACCOUNT_DELETION_ROUTE, body);
  return response.data;
};

/** Cancels a scheduled account deletion. Cancelling twice is a no-op. */
export const cancelAccountDeletion = async (): Promise<UserRead> => {
  const response = await apiClient.delete<UserRead>(ACCOUNT_DELETION_ROUTE);
  return response.data;
};
