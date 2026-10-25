/**
 * The admin list of third-party apps and where each stands with the workspace:
 * pending, approved or denied, as Linear's application approvals list shows
 * them. Pending requests carry who asked and why, and every decision carries
 * who made it and any reason given.
 *
 * Apps members authorized before approvals were required have no record, yet
 * they keep working, so they are drawn as approved from the workspace's grants
 * and an admin can revoke them like any other. Revoking marks the app denied
 * and removes every member's grant to it, so it cannot come back without an
 * admin approving it.
 */

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  invalidateQueries,
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  decideAppApproval,
  listAppApprovals,
  revokeAppApproval,
} from '../../api/appApprovals';
import { listWorkspaceConnectedApps } from '../../api/connectedApps';
import { approvalRows, type ApprovalRow } from '../../lib/appApprovals';
import { errorMessage } from '../../lib/errors';
import { workspaceSecuritySettingsPath } from '../../lib/paths';
import {
  appApprovalsKey,
  workspaceConnectedAppsKey,
} from '../../lib/queryKeys';
import type { AppApprovalStatus, WorkspaceRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge, { type BadgeTone } from '../ui/badge';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import { Textarea } from '../ui/input';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';

/** How often the list is re-read while the page is open. */
const POLL_MS = 60000;

/** The filters, in the order they show. */
const FILTERS: { value: AppApprovalStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
];

/** The badge each status wears. */
const STATUS_TONES: Record<AppApprovalStatus, BadgeTone> = {
  pending: 'warning',
  approved: 'success',
  denied: 'danger',
};

/** What a decision dialog is about: the app, and whether it denies or revokes. */
interface PendingDecision {
  row: ApprovalRow;
  decision: 'deny' | 'revoke';
}

/** The line under an app's name: who asked and why, or who decided and why. */
const RowDetail: React.FC<{ row: ApprovalRow }> = ({ row }) => {
  const { approval } = row;
  if (row.legacy) {
    return (
      <p className="text-xs text-text-faint">
        Authorized before approvals were required
      </p>
    );
  }
  const decided =
    approval.status !== 'pending' &&
    approval.decided_at !== null &&
    approval.decided_at !== undefined;
  return (
    <div className="space-y-0.5">
      {decided ? (
        <p className="flex flex-wrap items-center gap-x-1 text-xs text-text-faint">
          <span>
            {approval.status === 'approved' ? 'Approved' : 'Denied'} by{' '}
            {approval.decided_by?.display_name ?? 'an admin'}
          </span>
          <RelativeTime value={approval.decided_at ?? ''} />
        </p>
      ) : (
        approval.requested_at !== null &&
        approval.requested_at !== undefined && (
          <p className="flex flex-wrap items-center gap-x-1 text-xs text-text-faint">
            <span>
              Requested by {approval.requested_by?.display_name ?? 'a member'}
            </span>
            <RelativeTime value={approval.requested_at} />
          </p>
        )
      )}
      {decided && approval.decision_reason ? (
        <p className="text-xs text-text-muted">{approval.decision_reason}</p>
      ) : (
        !decided &&
        approval.request_reason && (
          <p className="text-xs text-text-muted">{approval.request_reason}</p>
        )
      )}
    </div>
  );
};

/** Props for AppApprovalsSection: the workspace whose apps are shown. */
export interface AppApprovalsSectionProps {
  workspace: WorkspaceRead;
}

/** Lists third-party apps by status, with approve, deny and revoke on each. */
export const AppApprovalsSection: React.FC<AppApprovalsSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const [filter, setFilter] = useState<AppApprovalStatus>('pending');
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const queryKey = appApprovalsKey(workspace.id);
  const grantsKey = workspaceConnectedAppsKey(workspace.id);

  const approvals = usePolledQuery(
    ({ signal }) => listAppApprovals(workspace.id, undefined, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );
  const grants = usePolledQuery(
    ({ signal }) => listWorkspaceConnectedApps(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey: grantsKey, auth }
  );

  const { mutate, isMutating } = useMutationWithRefetch(
    async (target: {
      row: ApprovalRow;
      decision: 'approve' | 'deny' | 'revoke';
      reason: string;
    }) => {
      const { client_id: clientId, client_name: clientName } =
        target.row.approval;
      if (target.decision === 'revoke') {
        return revokeAppApproval(
          workspace.id,
          clientId,
          target.reason,
          clientName
        );
      }
      return decideAppApproval(
        workspace.id,
        clientId,
        target.decision,
        target.reason,
        clientName
      );
    },
    queryKey
  );

  const rows = useMemo(
    () => approvalRows(approvals.data?.approvals ?? [], grants.data ?? []),
    [approvals.data, grants.data]
  );
  const shown = rows.filter((row) => row.approval.status === filter);
  const counts = (status: AppApprovalStatus): number =>
    rows.filter((row) => row.approval.status === status).length;

  const run = (
    row: ApprovalRow,
    decision: 'approve' | 'deny' | 'revoke',
    text: string
  ): void => {
    setActionError(null);
    void mutate({ row, decision, reason: text })
      .then(() => {
        invalidateQueries(grantsKey);
        setPending(null);
        setReason('');
      })
      .catch((failure: unknown) => {
        setActionError(failure);
      });
  };

  const close = (): void => {
    if (isMutating) return;
    setPending(null);
    setReason('');
    setActionError(null);
  };

  const enabled = approvals.data?.enabled === true;
  const loading =
    (approvals.isLoading && approvals.data === null) ||
    (grants.isLoading && grants.data === null);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Application approvals</h2>
        <p className="text-sm text-text-muted">
          {enabled ? (
            'Members need an admin to approve a third-party app before they can connect it.'
          ) : (
            <>
              Approval is not required, so members can connect any app. Turn it
              on in{' '}
              <Link
                to={`${workspaceSecuritySettingsPath(workspace.slug)}#third-party-apps`}
                className="text-accent hover:underline"
              >
                security settings
              </Link>
              .
            </>
          )}
        </p>
      </div>

      <div
        role="group"
        aria-label="Filter applications"
        className="flex items-center gap-1"
      >
        {FILTERS.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={filter === option.value ? 'secondary' : 'ghost'}
            aria-pressed={filter === option.value}
            onClick={() => {
              setFilter(option.value);
            }}
          >
            {option.label}
            <span className="ml-1 text-text-faint">{counts(option.value)}</span>
          </Button>
        ))}
      </div>

      {approvals.error !== null && (
        <ErrorAlert
          message={errorMessage(
            approvals.error,
            'Could not load the application approvals.'
          )}
        />
      )}
      {pending === null && actionError !== null && (
        <ErrorAlert
          message={errorMessage(actionError, 'Could not save that decision.')}
        />
      )}

      {loading ? (
        <Spinner label="Loading application approvals" />
      ) : shown.length === 0 ? (
        approvals.error === null && (
          <p className="text-sm text-text-muted">
            {filter === 'pending'
              ? 'No requests are waiting.'
              : filter === 'approved'
                ? 'No apps are approved.'
                : 'No apps are denied.'}
          </p>
        )
      ) : (
        <ul className="rounded-md border border-line">
          {shown.map((row) => (
            <li
              key={row.approval.client_id}
              className="grid min-h-row grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 hover:bg-surface"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="flex items-center gap-2 truncate text-sm text-text">
                  <span className="truncate font-medium">
                    {row.approval.client_name}
                  </span>
                  <Badge tone={STATUS_TONES[row.approval.status]}>
                    {FILTERS.find((f) => f.value === row.approval.status)
                      ?.label ?? row.approval.status}
                  </Badge>
                  {row.members > 0 && (
                    <span className="text-xs text-text-faint">
                      {row.members === 1
                        ? '1 member connected'
                        : `${row.members} members connected`}
                    </span>
                  )}
                </p>
                <RowDetail row={row} />
              </div>
              <div className="flex items-center gap-1">
                {row.approval.status !== 'approved' && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={isMutating}
                    aria-label={`Approve ${row.approval.client_name}`}
                    onClick={() => {
                      run(row, 'approve', '');
                    }}
                  >
                    Approve
                  </Button>
                )}
                {row.approval.status === 'pending' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isMutating}
                    aria-label={`Deny ${row.approval.client_name}`}
                    onClick={() => {
                      setActionError(null);
                      setPending({ row, decision: 'deny' });
                    }}
                  >
                    Deny
                  </Button>
                )}
                {row.approval.status === 'approved' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isMutating}
                    aria-label={`Revoke ${row.approval.client_name}`}
                    onClick={() => {
                      setActionError(null);
                      setPending({ row, decision: 'revoke' });
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={pending !== null}
        onClose={close}
        title={
          pending?.decision === 'revoke'
            ? `Revoke ${pending.row.approval.client_name}?`
            : `Deny ${pending?.row.approval.client_name ?? 'this app'}?`
        }
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {pending?.decision === 'revoke'
              ? 'Every member loses this app in this workspace, and nobody can connect it again until an admin approves it.'
              : 'The member who asked is told, and can send a new request later.'}
          </p>
          <label className="block space-y-1">
            <span className="text-xs text-text-muted">Reason (optional)</span>
            <Textarea
              value={reason}
              maxLength={1000}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </label>
          {pending !== null && actionError !== null && (
            <ErrorAlert
              message={errorMessage(
                actionError,
                'Could not save that decision.'
              )}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="danger"
              disabled={isMutating}
              onClick={() => {
                if (pending !== null)
                  run(pending.row, pending.decision, reason);
              }}
            >
              {pending?.decision === 'revoke' ? 'Revoke app' : 'Deny request'}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
};

export default AppApprovalsSection;
