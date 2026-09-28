/**
 * The caller's own account deletion: the plan that says what it would do to
 * each workspace, and the call that deletes the account. Kept apart from the
 * notification routes because these change the account rather than its
 * preferences.
 */

import apiClient from './client';
import type {
  AccountDeletionPlanRead,
  AccountDeletionRequest,
} from '../types/Api';

/** The route the caller's account is deleted through. */
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
 * Deletes the account at once, with the address typed out again. Every session
 * and credential stops working and the data is purged straight after. Refused
 * while the caller is the only owner of a workspace other people still use.
 */
export const deleteAccount = async (
  body: AccountDeletionRequest
): Promise<void> => {
  await apiClient.post(ACCOUNT_DELETION_ROUTE, body);
};
