/**
 * The outstanding invites of one workspace: creating them, revoking them, and
 * showing a new invite's token. The token comes back on creation only and is
 * never readable again, so it is held in state and surfaced until dismissed.
 */

import React, { useState } from 'react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { createInvite, listInvites, revokeInvite } from '../../api/workspaces';
import { useQueryAuth } from '../../hooks/useQueryAuth';
import { roleLabel } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { inviteLink, invitesKey } from '../../lib/queryKeys';
import type {
  InviteCreatedRead,
  InviteRole,
  WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
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
      ...(auth === undefined ? {} : { auth }),
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
      <h2 className="text-lg font-medium text-white">Invites</h2>

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
          className="space-y-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3"
        >
          <p className="text-sm text-emerald-100">
            Invite created for {created.email}. This link is shown once, so copy
            it now and send it to them.
          </p>
          <code className="block overflow-x-auto rounded border border-emerald-500/30 bg-slate-900 px-2 py-1 text-xs text-emerald-200">
            {inviteLink(created.token)}
          </code>
          <div className="flex gap-2">
            <Button onClick={onCopy}>{copied ? 'Copied' : 'Copy link'}</Button>
            <Button
              variant="secondary"
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
        <p className="text-sm text-slate-400">
          There are no outstanding invites.
        </p>
      ) : (
        <ul className="space-y-2">
          {data.map((item) => (
            <li
              key={item.invite_id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-700 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-100">{item.email}</p>
                <p className="text-xs text-slate-500">{roleLabel(item.role)}</p>
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  void revoke(item.invite_id).catch(() => undefined);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-4 rounded-md border border-slate-700 p-4"
        onSubmit={onSubmit}
      >
        <h3 className="text-sm font-medium text-white">Invite someone</h3>

        {createError !== null && (
          <ErrorAlert
            message={errorMessage(createError, 'Could not create the invite.')}
          />
        )}

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

        <Button type="submit" disabled={!canSubmit}>
          {isMutating ? 'Sending' : 'Create invite'}
        </Button>
      </form>
    </section>
  );
};

export default InvitesSection;
