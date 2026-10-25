/**
 * The workspace's reusable invite link: enable it, copy it, reset it and
 * disable it. Anyone who opens the link and signs in joins as a member, within
 * the plan's member cap and the workspace's sign-in rules. The token is stored
 * only as a hash, so a link is readable once, right after it is enabled or
 * reset, and a reset is the way to get a copyable link again. Resetting or
 * disabling makes the old link stop working at once.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  disableInviteLink,
  getInviteLink,
  resetInviteLink,
} from '../../api/workspaces';
import { errorMessage } from '../../lib/errors';
import { inviteLinkKey, workspaceJoinLink } from '../../lib/queryKeys';
import type { WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Spinner from '../ui/spinner';

/** Props for InviteLinkSection: the workspace whose link is managed. */
export interface InviteLinkSectionProps {
  workspace: WorkspaceRead;
}

/** How often the link's status is re-read while the settings page is open. */
const POLL_MS = 60000;

/** How a link's creation date reads. */
const dateLabel = (value: string | null): string => {
  if (value === null) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString();
};

/** Manages the invite link, showing a freshly minted one until dismissed. */
export const InviteLinkSection: React.FC<InviteLinkSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const queryKey = inviteLinkKey(workspace.id);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getInviteLink(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: reset,
    isMutating: isResetting,
    error: resetError,
  } = useMutationWithRefetch(() => resetInviteLink(workspace.id), [queryKey]);

  const {
    mutate: disable,
    isMutating: isDisabling,
    error: disableError,
  } = useMutationWithRefetch(() => disableInviteLink(workspace.id), [queryKey]);

  const busy = isResetting || isDisabling;
  const enabled = data?.enabled === true;

  const onReset = (): void => {
    setConfirmingReset(false);
    void reset()
      .then((result) => {
        setToken(result.token);
        setCopied(false);
      })
      .catch(() => undefined);
  };

  const onDisable = (): void => {
    setConfirmingReset(false);
    void disable()
      .then(() => {
        setToken(null);
      })
      .catch(() => undefined);
  };

  const onCopy = (): void => {
    if (token === null) return;
    void globalThis.navigator.clipboard
      ?.writeText(workspaceJoinLink(token))
      .then(() => {
        setCopied(true);
      })
      .catch(() => undefined);
  };

  return (
    <div className="space-y-3 rounded-md border border-line p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            Invite link
            {enabled && <Badge tone="success">On</Badge>}
          </h3>
          <p className="text-sm text-text-muted">
            Anyone with this link can join as a member after signing in. The
            workspace sign-in rules and the plan member limit still apply.
          </p>
        </div>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the invite link.')}
        />
      )}
      {resetError !== null && (
        <ErrorAlert
          message={errorMessage(resetError, 'Could not create a new link.')}
        />
      )}
      {disableError !== null && (
        <ErrorAlert
          message={errorMessage(disableError, 'Could not disable the link.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading the invite link" />
      ) : (
        <>
          {token !== null && (
            <div
              role="status"
              className="space-y-3 rounded-md border border-success/30 bg-success-soft p-3"
            >
              <p className="text-sm text-text">
                This link is shown once, so copy it now. Reset it later to get a
                new one.
              </p>
              <code className="block overflow-x-auto rounded-sm border border-line bg-bg px-2 py-1 font-mono text-xs text-text">
                {workspaceJoinLink(token)}
              </code>
              <div className="flex gap-1.5">
                <Button variant="primary" size="sm" onClick={onCopy}>
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setToken(null);
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}

          {enabled && token === null && (
            <p className="text-sm text-text-muted">
              The link is on
              {dateLabel(data.created_at) === ''
                ? '.'
                : ` since ${dateLabel(data.created_at)}.`}{' '}
              Reset it to copy a new link.
            </p>
          )}

          {confirmingReset ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-text">
                The current link stops working at once.
              </p>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={onReset}
              >
                Reset link
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfirmingReset(false);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {enabled ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setConfirmingReset(true);
                    }}
                  >
                    Reset link
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={onDisable}
                  >
                    {isDisabling ? 'Disabling' : 'Disable link'}
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={onReset}
                >
                  {isResetting ? 'Enabling' : 'Enable invite link'}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default InviteLinkSection;
