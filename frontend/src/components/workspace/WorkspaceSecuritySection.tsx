/**
 * The workspace authentication policy: a switch that requires every member to
 * have an authenticator app or a passkey, and a row of the sign-in methods
 * that may reach the workspace.
 *
 * Tightening either needs the Business plan, and the admin's own session must
 * still meet the result, so the controls say what is missing rather than
 * letting the server refuse it. Loosening is always allowed.
 */

import React, { useId } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { getAuthPolicy, updateAuthPolicy } from '../../api/workspaces';
import { useAuth } from '../../hooks/useAuth';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { workspaceAuthPolicyKey } from '../../lib/queryKeys';
import { SIGN_IN_METHOD_NAMES, SIGN_IN_METHODS } from '../../lib/signInMethods';
import { showToast } from '../../lib/toast';
import type {
  AuthPolicyUpdate,
  SignInMethod,
  WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Checkbox from '../ui/checkbox';
import TextLink from '../ui/link';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';

/** Props for WorkspaceSecuritySection: the workspace whose policy is shown. */
export interface WorkspaceSecuritySectionProps {
  workspace: WorkspaceRead;
}

/** How often the policy is re-read while the tab is open. */
const POLL_MS = 60000;

/** Shows and changes the workspace's second factor and sign-in method rules. */
export const WorkspaceSecuritySection: React.FC<
  WorkspaceSecuritySectionProps
> = ({ workspace }) => {
  const auth = useQueryAuth();
  const { user } = useAuth();
  const baseId = useId();
  const switchLabelId = `${baseId}-two-factor`;
  const methodsLabelId = `${baseId}-methods`;
  const queryKey = workspaceAuthPolicyKey(workspace.id);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getAuthPolicy(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (body: AuthPolicyUpdate) => updateAuthPolicy(workspace.id, body),
    [queryKey]
  );

  const required = data?.require_two_factor ?? false;
  const available = data?.available ?? false;
  const ownFactor = user?.two_factor === true;
  const canTurnOn = available && ownFactor;
  const locked = !required && !canTurnOn;
  const allowed = data?.allowed_methods ?? [...SIGN_IN_METHODS];
  const currentMethod = data?.current_method ?? null;
  const restricted = allowed.length < SIGN_IN_METHODS.length;

  /** Whether the admin may untick `method` right now. */
  const canExclude = (method: SignInMethod): boolean =>
    available &&
    currentMethod !== null &&
    method !== currentMethod &&
    allowed.length > 1;

  const toggleMethod = async (method: SignInMethod): Promise<void> => {
    if (saving) return;
    const including = !allowed.includes(method);
    if (!including && !canExclude(method)) return;
    const next = SIGN_IN_METHODS.filter((candidate) =>
      candidate === method ? including : allowed.includes(candidate)
    );
    try {
      await save({ allowed_methods: next });
      await refetch();
      showToast(
        including
          ? `${SIGN_IN_METHOD_NAMES[method]} sign-in is now allowed.`
          : `${SIGN_IN_METHOD_NAMES[method]} sign-in is no longer allowed.`
      );
    } catch {
      return;
    }
  };

  const toggle = async (): Promise<void> => {
    if (saving || locked) return;
    try {
      await save({ require_two_factor: !required });
      await refetch();
      showToast(
        required
          ? 'Two-factor authentication is no longer required.'
          : 'Two-factor authentication is now required.'
      );
    } catch {
      return;
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Authentication</h2>
        <p className="text-sm text-text-muted">
          Control how members of {workspace.name} must sign in.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the security settings.')}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save the security settings.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the security settings" />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
            <div className="min-w-0 space-y-0.5">
              <span
                id={switchLabelId}
                className="block text-sm font-medium text-text"
              >
                Require two-factor authentication
              </span>
              <p className="text-xs text-text-muted">
                Members without an authenticator app or a passkey lose access
                until they add one. API keys and connected apps keep working.
              </p>
              {!required && !available && (
                <p className="text-xs text-text-muted">
                  Available on the Business plan.{' '}
                  <TextLink to={`/w/${workspace.slug}/settings/billing`}>
                    View plans
                  </TextLink>
                </p>
              )}
              {!required && available && !ownFactor && (
                <p className="text-xs text-text-muted">
                  Add an authenticator app or a passkey to your own account
                  first.{' '}
                  <TextLink to="/security">Account security</TextLink>
                </p>
              )}
              {required && data?.updated_at && (
                <p className="text-xs text-text-faint">
                  Turned on <RelativeTime value={data.updated_at} />
                </p>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={required}
              aria-labelledby={switchLabelId}
              disabled={saving || locked}
              onClick={() => {
                void toggle();
              }}
              className={cn(
                'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
                required
                  ? 'bg-accent enabled:hover:bg-accent-strong'
                  : 'bg-line-strong enabled:hover:bg-text-faint'
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block h-3 w-3 rounded-full bg-bg shadow-sm transition-transform duration-100',
                  required ? 'translate-x-3' : 'translate-x-0'
                )}
              />
            </button>
          </li>
          <li className="space-y-2 px-3 py-2">
            <div className="min-w-0 space-y-0.5">
              <span
                id={methodsLabelId}
                className="block text-sm font-medium text-text"
              >
                Allowed sign-in methods
              </span>
              <p className="text-xs text-text-muted">
                Members who signed in another way lose access until they sign in
                with an allowed method. API keys and connected apps keep
                working.
              </p>
              {!restricted && !available && (
                <p className="text-xs text-text-muted">
                  Available on the Business plan.{' '}
                  <TextLink to={`/w/${workspace.slug}/settings/billing`}>
                    View plans
                  </TextLink>
                </p>
              )}
              {available && currentMethod !== null && (
                <p className="text-xs text-text-muted">
                  You signed in with {SIGN_IN_METHOD_NAMES[currentMethod]}, so
                  it stays allowed.
                </p>
              )}
              {available && currentMethod === null && (
                <p className="text-xs text-text-muted">
                  Sign out and sign in again to change the allowed methods.
                </p>
              )}
            </div>
            <div
              role="group"
              aria-labelledby={methodsLabelId}
              className="flex flex-wrap gap-x-4 gap-y-2"
            >
              {SIGN_IN_METHODS.map((method) => {
                const checked = allowed.includes(method);
                return (
                  <Checkbox
                    key={method}
                    label={SIGN_IN_METHOD_NAMES[method]}
                    checked={checked}
                    disabled={saving || (checked && !canExclude(method))}
                    onChange={() => {
                      void toggleMethod(method);
                    }}
                  />
                );
              })}
            </div>
          </li>
        </ul>
      )}
    </section>
  );
};

export default WorkspaceSecuritySection;
