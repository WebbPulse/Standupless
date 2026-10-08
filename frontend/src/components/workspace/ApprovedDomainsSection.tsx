/**
 * Approved email domains: people with a verified address on one of these can
 * join the workspace as members without an invite.
 *
 * An admin can only approve the domain of their own verified email, the same
 * rule the server holds, so the section offers that one domain instead of a
 * free text field that would mostly answer 403.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuX } from 'react-icons/lu';
import {
  addApprovedDomain,
  listApprovedDomains,
  removeApprovedDomain,
} from '../../api/workspaces';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../lib/errors';
import { workspaceApprovedDomainsKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button, { IconButton } from '../ui/button';
import TextLink from '../ui/link';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';

/** Props for ApprovedDomainsSection: the workspace whose domains are shown. */
export interface ApprovedDomainsSectionProps {
  workspace: WorkspaceRead;
}

/** How often the domain list is re-read while the tab is open. */
const POLL_MS = 60000;

/** The domain part of an email address, lowercased, or null without one. */
const emailDomain = (email: string | null | undefined): string | null => {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
};

/** Lists, approves and removes the workspace's approved email domains. */
export const ApprovedDomainsSection: React.FC<ApprovedDomainsSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const { user } = useAuth();
  const queryKey = workspaceApprovedDomainsKey(workspace.id);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => listApprovedDomains(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: add,
    error: addError,
    isMutating: adding,
  } = useMutationWithRefetch(
    (domain: string) => addApprovedDomain(workspace.id, domain),
    [queryKey]
  );

  const {
    mutate: remove,
    error: removeError,
    isMutating: removing,
  } = useMutationWithRefetch(
    (domain: string) => removeApprovedDomain(workspace.id, domain),
    [queryKey]
  );

  const domains = data ?? [];
  const ownDomain = user?.email_verified ? emailDomain(user.email) : null;
  const ownApproved =
    ownDomain !== null && domains.some((row) => row.domain === ownDomain);

  const approve = async (): Promise<void> => {
    if (ownDomain === null || adding) return;
    try {
      await add(ownDomain);
      await refetch();
      showToast(`Anyone with a verified ${ownDomain} email can now join.`);
    } catch {
      return;
    }
  };

  const drop = async (domain: string): Promise<void> => {
    if (removing) return;
    try {
      await remove(domain);
      await refetch();
      showToast(`${domain} is no longer approved.`);
    } catch {
      return;
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Approved email domains</h2>
        <p className="text-sm text-text-muted">
          Anyone with a verified email on an approved domain can join{' '}
          {workspace.name} as a member without an invite. People who already
          joined stay when a domain is removed.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the approved domains.')}
        />
      )}
      {addError !== null && (
        <ErrorAlert
          message={errorMessage(addError, 'Could not approve the domain.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not remove the domain.')}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the approved domains" />
      ) : (
        <ul
          aria-label="Approved email domains"
          className="divide-y divide-line rounded-md border border-line"
        >
          {domains.length === 0 && (
            <li className="flex min-h-row items-center px-3 py-2 text-sm text-text-muted">
              No approved domains. Members join by invite only.
            </li>
          )}
          {domains.map((row) => (
            <li
              key={row.domain}
              className="flex min-h-row items-center justify-between gap-4 px-3 py-2"
            >
              <div className="min-w-0 space-y-0.5">
                <span className="block truncate text-sm font-medium text-text">
                  {row.domain}
                </span>
                <p className="text-xs text-text-faint">
                  Approved <RelativeTime value={row.added_at} />
                </p>
              </div>
              <IconButton
                label={`Remove ${row.domain}`}
                size="sm"
                disabled={removing}
                onClick={() => {
                  void drop(row.domain);
                }}
              >
                <LuX className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </li>
          ))}
          {ownDomain !== null && !ownApproved && (
            <li className="flex min-h-row items-center justify-between gap-4 px-3 py-2">
              <p className="min-w-0 text-sm text-text-muted">
                Let people with a verified {ownDomain} email join.
              </p>
              <Button
                size="sm"
                variant="primary"
                disabled={adding}
                onClick={() => {
                  void approve();
                }}
              >
                Approve {ownDomain}
              </Button>
            </li>
          )}
        </ul>
      )}

      {ownDomain === null && (
        <p className="text-xs text-text-muted">
          Approving a domain needs a verified email.{' '}
          <TextLink to="/verify-email">Verify your email</TextLink>
        </p>
      )}
      <p className="text-xs text-text-faint">
        You can only approve the domain of your own verified email, and public
        providers such as gmail.com cannot be approved.
      </p>
    </section>
  );
};

export default ApprovedDomainsSection;
