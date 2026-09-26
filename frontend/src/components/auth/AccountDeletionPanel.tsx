/**
 * Deleting the signed in account, Linear style: the plan first, so the person
 * sees which workspaces go with the account and which only lose a member, then
 * the address typed out again and a step-up. A workspace where they are the only
 * owner and other people remain blocks it until ownership moves or the
 * workspace is deleted, because nobody else could then run it.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  cancelAccountDeletion,
  getAccountDeletionPlan,
  scheduleAccountDeletion,
} from '../../api/account';
import { useAuth } from '../../hooks/useAuth';
import { DELETION_GRACE_DAYS, purgeDateLabel } from '../../lib/deletion';
import { errorMessage } from '../../lib/errors';
import { ACCOUNT_DELETION_PLAN_KEY } from '../../lib/queryKeys';
import type { WorkspaceSummaryRead } from '../../types/Api';
import ConfirmDeletionDialog from '../deletion/ConfirmDeletionDialog';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import TextLink from '../ui/link';
import Spinner from '../ui/spinner';

/** How often the plan is re-read while the page is open. */
const POLL_MS = 60000;

/** Names a list of workspaces, each linking to its settings. */
const WorkspaceLinks: React.FC<{ rows: WorkspaceSummaryRead[] }> = ({
  rows,
}) => (
  <ul className="list-disc space-y-0.5 pl-5">
    {rows.map((row) => (
      <li key={row.id}>
        <TextLink to={`/w/${row.slug}/settings`}>{row.name}</TextLink>
      </li>
    ))}
  </ul>
);

/** Schedules or cancels the signed in account's deletion. */
export const AccountDeletionPanel: React.FC = () => {
  const auth = useQueryAuth();
  const { user, checkAuthStatus } = useAuth();
  const [open, setOpen] = useState(false);
  const [purgeAfter, setPurgeAfter] = useState<string | null | undefined>(
    undefined
  );

  const { data: plan, error } = usePolledQuery(
    ({ signal }) => getAccountDeletionPlan(signal),
    { intervalMs: POLL_MS, queryKey: ACCOUNT_DELETION_PLAN_KEY, auth }
  );

  const {
    mutate: cancel,
    isMutating: cancelling,
    error: cancelError,
  } = useMutationWithRefetch(async () => {
    const updated = await cancelAccountDeletion();
    setPurgeAfter(updated.purge_after ?? null);
    await checkAuthStatus();
  }, ACCOUNT_DELETION_PLAN_KEY);

  if (user === null) return null;
  const scheduledFor =
    purgeAfter === undefined ? (user.purge_after ?? null) : purgeAfter;
  const blocking = plan?.blocking ?? [];

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-danger">Delete account</h2>
        <p className="text-sm text-text-muted">
          Your account is deleted permanently {DELETION_GRACE_DAYS} days after
          you ask, and you can cancel until then.
        </p>
      </div>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load what deletion affects.')}
        />
      )}
      {cancelError !== null && (
        <ErrorAlert
          message={errorMessage(cancelError, 'Could not cancel the deletion.')}
        />
      )}
      <div className="rounded-md border border-danger/30 px-3 py-3 text-sm">
        {scheduledFor !== null ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium text-text">
                Your account will be permanently deleted on{' '}
                {purgeDateLabel(scheduledFor)}.
              </p>
              <p className="text-text-muted">
                You can keep using it until then.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              Cancel deletion
            </Button>
          </div>
        ) : plan === null ? (
          <Spinner label="Loading what deletion affects" />
        ) : blocking.length > 0 ? (
          <div className="space-y-2">
            <p className="font-medium text-text">
              You are the only owner of workspaces other people still use.
            </p>
            <p className="text-text-muted">
              Make someone else an owner, or delete the workspace, before
              deleting your account:
            </p>
            <WorkspaceLinks rows={blocking} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium text-text">Delete your account</p>
              <p className="text-text-muted">
                Removes your sign in, memberships and personal data.
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
              Delete account
            </Button>
          </div>
        )}
      </div>
      {plan !== null && (
        <ConfirmDeletionDialog
          open={open}
          onClose={() => setOpen(false)}
          title="Delete your account"
          confirmLabel={`Type ${user.email} to confirm`}
          expected={user.email}
          ignoreCase
          submitLabel="Schedule deletion"
          failureMessage="Could not schedule the deletion."
          onConfirm={async (typed) => {
            const updated = await scheduleAccountDeletion({
              confirm_email: typed,
            });
            setPurgeAfter(updated.purge_after ?? null);
            await checkAuthStatus();
          }}
        >
          <p>
            Your account is deleted permanently after {DELETION_GRACE_DAYS}{' '}
            days: your sign in methods, passkeys, API keys, connected apps and
            profile. Issues and comments you wrote stay in their workspaces and
            show as written by a deleted user.
          </p>
          {plan.deleted_with_account.length > 0 && (
            <div className="space-y-1">
              <p>
                These workspaces have nobody else in them and are deleted with
                your account:
              </p>
              <WorkspaceLinks rows={plan.deleted_with_account} />
            </div>
          )}
          {plan.leaving.length > 0 && (
            <div className="space-y-1">
              <p>You are removed from these workspaces:</p>
              <WorkspaceLinks rows={plan.leaving} />
            </div>
          )}
          <p>We email you now, and you can cancel from this page until then.</p>
        </ConfirmDeletionDialog>
      )}
    </section>
  );
};

export default AccountDeletionPanel;
