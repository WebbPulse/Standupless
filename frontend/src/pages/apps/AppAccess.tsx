/**
 * The page a member lands on when they authorize a third-party app their
 * workspace requires an admin to approve. No grant was made, so the app has no
 * access yet. The page names the app, takes an optional reason and sends the
 * request to the workspace's admins. A request that was denied before shows
 * the admin's reason, and the member may ask again.
 *
 * Once the app is approved, Continue resumes the very authorization the member
 * started, which the signed request ticket carries. The page sits behind
 * `ProtectedRoute`, so a signed out visitor comes back here after login.
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAppAccessRequest, requestAppAccess } from '../../api/appApprovals';
import AccountShell from '../../components/layout/AccountShell';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import { Textarea } from '../../components/ui/input';
import TextLink from '../../components/ui/link';
import Spinner from '../../components/ui/spinner';
import { errorMessage } from '../../lib/errors';
import type { AppAccessRequestRead, AppApprovalRead } from '../../types/Api';

/** The longest reason the server keeps. */
const REASON_LIMIT = 1000;

/** The panel the page draws inside. */
const Panel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AccountShell width="narrow">
    <div className="space-y-5 rounded-lg border border-line bg-bg p-6">
      {children}
    </div>
  </AccountShell>
);

/** The link that resumes the authorization the member was stopped on. */
const ContinueLink: React.FC<{ href: string }> = ({ href }) => (
  <a
    href={href}
    className="inline-flex h-8 items-center rounded-sm border border-transparent bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-strong"
  >
    Continue
  </a>
);

/** Loads the request a ticket names, then lets the member ask for access. */
const AppAccess: React.FC = () => {
  const [params] = useSearchParams();
  const workspaceId = params.get('workspace_id');
  const ticket = params.get('ticket');
  const [request, setRequest] = useState<AppAccessRequestRead | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);

  useEffect(() => {
    if (workspaceId === null || ticket === null) return;
    const controller = new AbortController();
    getAppAccessRequest(workspaceId, ticket, controller.signal)
      .then((loaded) => {
        setRequest(loaded);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setLoadError(failure);
      });
    return () => {
      controller.abort();
    };
  }, [workspaceId, ticket]);

  if (workspaceId === null || ticket === null) {
    return (
      <Panel>
        <h1 className="text-lg font-semibold">Request access</h1>
        <p className="text-sm text-text-muted">
          This link is missing its request details. Authorize the app again to
          get a new one.
        </p>
      </Panel>
    );
  }

  if (loadError !== null) {
    return (
      <Panel>
        <h1 className="text-lg font-semibold">Request access</h1>
        <ErrorAlert
          message={errorMessage(
            loadError,
            'This request link is not valid or has expired. Authorize the app again to get a new one.'
          )}
        />
        <p className="text-sm text-text-muted">
          <TextLink to="/workspaces">Go to your workspaces</TextLink>
        </p>
      </Panel>
    );
  }

  if (request === null) {
    return <Spinner label="Loading the request" />;
  }

  const approval: AppApprovalRead | null = request.approval ?? null;
  const app = request.client_name || 'This app';

  const send = (): void => {
    setSending(true);
    setSendError(null);
    void requestAppAccess(workspaceId, ticket, reason.trim())
      .then((stored) => {
        setRequest({ ...request, approval: stored });
        setReason('');
      })
      .catch((failure: unknown) => {
        setSendError(failure);
      })
      .finally(() => {
        setSending(false);
      });
  };

  if (!request.enabled || approval?.status === 'approved') {
    return (
      <Panel>
        <h1 className="text-lg font-semibold">{app} is approved</h1>
        <p className="text-sm text-text-muted">
          {request.enabled
            ? `An admin approved ${app} for ${request.workspace_name}. Continue to finish connecting it.`
            : `${request.workspace_name} no longer requires approval for third-party apps. Continue to finish connecting ${app}.`}
        </p>
        <ContinueLink href={request.return_to} />
      </Panel>
    );
  }

  if (approval?.status === 'pending') {
    return (
      <Panel>
        <h1 className="text-lg font-semibold">Request sent</h1>
        <p role="status" className="text-sm text-text-muted">
          The admins of {request.workspace_name} have been asked to approve{' '}
          {app}. You will get a notification when they decide, then you can
          authorize it again.
        </p>
        {approval.request_reason && (
          <p className="rounded-sm bg-surface p-2 text-sm text-text">
            {approval.request_reason}
          </p>
        )}
        <p className="text-sm text-text-muted">
          <TextLink to="/workspaces">Go to your workspaces</TextLink>
        </p>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Request access to {app}</h1>
        <p className="text-sm text-text-muted">
          {request.workspace_name} requires an admin to approve third-party apps
          before they can connect. Nothing has been shared with {app}.
        </p>
      </div>
      {approval?.status === 'denied' && (
        <div className="space-y-1 rounded-sm border border-line p-3">
          <p className="text-sm text-text">
            {approval.decided_by?.display_name ?? 'An admin'} denied an earlier
            request for {app}.
          </p>
          {approval.decision_reason && (
            <p className="text-sm text-text-muted">
              {approval.decision_reason}
            </p>
          )}
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-xs text-text-muted">
          Why do you need it? (optional)
        </span>
        <Textarea
          value={reason}
          maxLength={REASON_LIMIT}
          disabled={sending}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>
      {sendError !== null && (
        <ErrorAlert
          message={errorMessage(sendError, 'Could not send the request.')}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="primary"
          disabled={sending}
          onClick={() => {
            send();
          }}
        >
          {sending ? 'Sending' : 'Request access'}
        </Button>
      </div>
    </Panel>
  );
};

export default AppAccess;
