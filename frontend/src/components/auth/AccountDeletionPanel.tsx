/**
 * Deleting the signed in account, Linear style: the plan first, so the person
 * sees which workspaces go with the account and which only lose a member, then
 * the address typed out again and a step-up. A workspace where they are the only
 * owner and other people remain blocks it until ownership moves, because nobody
 * else could then run it. Once confirmed the account is gone at once, so the
 * panel signs out and lands on the signed out confirmation page.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { deleteAccount, getAccountDeletionPlan } from '../../api/account';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../lib/errors';
import { ACCOUNT_DELETED_PATH } from '../../lib/paths';
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
        {row.deletion_scheduled === true && (
          <span className="text-text-muted"> (deletion scheduled)</span>
        )}
      </li>
    ))}
  </ul>
);

/** Deletes the signed in account once the plan allows it and the person confirms. */
export const AccountDeletionPanel: React.FC = () => {
  const auth = useQueryAuth();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  const { data: plan, error } = usePolledQuery(
    ({ signal }) => getAccountDeletionPlan(signal),
    { intervalMs: POLL_MS, queryKey: ACCOUNT_DELETION_PLAN_KEY, auth }
  );

  if (user === null) return null;
  const blocking = plan?.blocking ?? [];

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-danger">Delete account</h2>
        <p className="text-sm text-text-muted">
          Deleting your account is immediate and cannot be undone.
        </p>
      </div>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load what deletion affects.')}
        />
      )}
      <div className="rounded-md border border-danger/30 px-3 py-3 text-sm">
        {plan === null ? (
          <Spinner label="Loading what deletion affects" />
        ) : blocking.length > 0 ? (
          <div className="space-y-2">
            <p className="font-medium text-text">
              You are the only owner of workspaces other people still use.
            </p>
            <p className="text-text-muted">
              Make someone else an owner before deleting your account. A
              workspace whose deletion is scheduled still needs one, because its
              deletion can be cancelled:
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
          submitLabel="Delete account"
          verifyLabel="Verify and delete"
          failureMessage="Could not delete the account."
          onConfirm={async (typed) => {
            await deleteAccount({ confirm_email: typed });
            await logout(ACCOUNT_DELETED_PATH);
          }}
        >
          <p>
            Your account is deleted as soon as you confirm, and this cannot be
            undone. You are signed out everywhere, and your sign in methods,
            passkeys, API keys, connected apps and profile stop working and are
            removed. Issues and comments you wrote stay in their workspaces and
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
          <p>We email you a confirmation.</p>
        </ConfirmDeletionDialog>
      )}
    </section>
  );
};

export default AccountDeletionPanel;
