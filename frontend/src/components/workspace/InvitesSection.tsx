/**
 * The outstanding invites of one workspace: creating them, revoking them, and
 * showing a new invite's token. The token comes back on creation only and is
 * never readable again, so it is held in state and surfaced until dismissed.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { createInvite, listInvites, revokeInvite } from '../../api/workspaces';
import { roleLabel } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { inviteLink, invitesKey } from '../../lib/queryKeys';
import type {
  InviteCreatedRead,
  InviteRole,
  WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Field from '../ui/field';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for InvitesSection: the workspace whose invites are shown. */
export interface InvitesSectionProps {
  workspace: WorkspaceRead;
}

/** How often the invite list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** The roles an invite may carry. The contract never issues an owner invite. */
const INVITE_ROLES: InviteRole[] = ['admin', 'member', 'guest'];

/** The column layout the header and every row share. */
const COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_5rem_auto_auto] items-center gap-3 px-3';

/** How an expiry reads in the list. */
const expiryLabel = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleDateString();
};

/** Lists and creates invites, and shows a new one's token once. */
export const InvitesSection: React.FC<InvitesSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const queryKey = invitesKey(workspace.id);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [created, setCreated] = useState<InviteCreatedRead | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listInvites(workspace.id, signal),
    {
      intervalMs: POLL_MS,
      queryKey,
      auth,
    }
  );

  const {
    mutate: invite,
    isMutating,
    error: createError,
  } = useMutationWithRefetch(
    (body: { email: string; role: InviteRole }) =>
      createInvite(workspace.id, body),
    queryKey
  );

  const { mutate: revoke, error: revokeError } = useMutationWithRefetch(
    (inviteId: string) => revokeInvite(workspace.id, inviteId),
    queryKey
  );

  const canSubmit = email.trim() !== '' && !isMutating;

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    void invite({ email: email.trim(), role })
      .then((result) => {
        setCreated(result);
        setCopied(false);
        setEmail('');
        setRole('member');
      })
      .catch(() => undefined);
  };

  const onCopy = (): void => {
    if (created === null) return;
    void globalThis.navigator.clipboard
      ?.writeText(inviteLink(created.token))
      .then(() => {
        setCopied(true);
      })
      .catch(() => undefined);
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Invites</h2>
        <p className="text-sm text-text-muted">
          Invites waiting to be accepted, and a form to send another.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the invites.')}
        />
      )}
      {revokeError !== null && (
        <ErrorAlert
          message={errorMessage(revokeError, 'Could not revoke that invite.')}
        />
      )}

      {created !== null && (
        <div
          role="status"
          className="space-y-3 rounded-md border border-success/30 bg-success-soft p-3"
        >
          <p className="text-sm text-text">
            Invite created for {created.email}. This link is shown once, so copy
            it now and send it to them.
          </p>
          <code className="block overflow-x-auto rounded-sm border border-line bg-bg px-2 py-1 font-mono text-xs text-text">
            {inviteLink(created.token)}
          </code>
          <div className="flex gap-1.5">
            <Button variant="primary" size="sm" onClick={onCopy}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCreated(null);
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading invites" />
      ) : data.length === 0 ? (
        <p className="text-sm text-text-muted">
          There are no outstanding invites.
        </p>
      ) : (
        <div className="rounded-md border border-line">
          <div
            className={`${COLUMNS} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
          >
            <span>Email</span>
            <span>Role</span>
            <span>Status</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul>
            {data.map((item) => (
              <li
                key={item.invite_id}
                className={`${COLUMNS} h-row border-b border-line transition-colors duration-100 last:border-b-0 hover:bg-surface`}
              >
                <span className="truncate text-sm font-medium">
                  {item.email}
                </span>
                <span className="text-xs text-text-muted">
                  {roleLabel(item.role)}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone="warning">Pending</Badge>
                  <span className="hidden text-xs text-text-faint sm:inline">
                    until {expiryLabel(item.expires_at)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void revoke(item.invite_id).catch(() => undefined);
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        className="space-y-4 rounded-md border border-line p-4"
        onSubmit={onSubmit}
      >
        <h3 className="text-sm font-medium">Invite someone</h3>

        {createError !== null && (
          <ErrorAlert
            message={errorMessage(createError, 'Could not create the invite.')}
          />
        )}

        <div className="grid max-w-md gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <Field
            id="invite-email"
            label="Email"
            type="email"
            value={email}
            autoComplete="off"
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />

          <SelectField
            id="invite-role"
            label="Role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as InviteRole);
            }}
          >
            {INVITE_ROLES.map((item) => (
              <option key={item} value={item}>
                {roleLabel(item)}
              </option>
            ))}
          </SelectField>
        </div>

        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {isMutating ? 'Sending' : 'Create invite'}
        </Button>
      </form>
    </section>
  );
};

export default InvitesSection;
