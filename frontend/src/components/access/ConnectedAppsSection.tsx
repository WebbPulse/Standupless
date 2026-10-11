/**
 * Connected apps: the OAuth clients, such as an MCP client in an editor, that
 * a person has let act for them.
 *
 * Two lists share one row shape. The caller's own list is open to every
 * member, because a grant is theirs to end. The workspace list shows every
 * member's grant in this workspace and is drawn only for an admin, because the
 * server refuses it to anyone else and an empty panel behind a refused read is
 * worse than one that was never there.
 *
 * Revoking cannot be undone from here: the client loses its refresh tokens and
 * has to be authorized again, so every revoke goes through a confirmation that
 * says exactly that.
 *
 * When the product adds scopes after an app was authorized, the app's row
 * offers to grant them. Granting adds only the listed scopes to the existing
 * grant, so the app picks them up at its next token refresh without being
 * authorized again.
 */

import React, { useState } from 'react';
import { LuPlug } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  grantMyConnectedAppScopes,
  listMyConnectedApps,
  listWorkspaceConnectedApps,
  revokeMyConnectedApp,
  revokeWorkspaceConnectedApp,
} from '../../api/connectedApps';
import { errorMessage } from '../../lib/errors';
import {
  MY_CONNECTED_APPS_KEY,
  workspaceConnectedAppsKey,
} from '../../lib/queryKeys';
import type {
  ConnectedAppRead,
  WorkspaceConnectedAppRead,
  WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import EmptyState from '../ui/empty-state';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';

/** How often the lists are re-read while the page is open. */
const POLL_MS = 60000;

/** The column layout every row shares. */
const COLUMNS =
  'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3';

/** What a revoke confirmation is about: the client, and whose grant it is. */
interface PendingRevoke {
  clientId: string;
  clientName: string;
  userId?: string;
  userLabel?: string;
}

/** A square with the client's initial, standing in for a logo no client sends. */
const AppMark: React.FC<{ name: string }> = ({ name }) => (
  <span
    aria-hidden="true"
    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line bg-raised text-xs font-semibold text-text-muted"
  >
    {(name.trim()[0] ?? '?').toUpperCase()}
  </span>
);

/** "Authorized 3d ago, last used 2h ago", or "never used" for an idle grant. */
const Timeline: React.FC<{
  authorizedAt: string | null;
  lastUsedAt: string | null;
}> = ({ authorizedAt, lastUsedAt }) => (
  <p className="flex flex-wrap items-center gap-x-1 text-xs text-text-faint">
    {authorizedAt !== null && (
      <>
        <span>Authorized</span>
        <RelativeTime value={authorizedAt} />
        <span aria-hidden="true">/</span>
      </>
    )}
    {lastUsedAt === null ? (
      <span>Never used</span>
    ) : (
      <>
        <span>Last used</span>
        <RelativeTime value={lastUsedAt} />
      </>
    )}
  </p>
);

/** Props for RevokeDialog: what is being revoked and the call that does it. */
interface RevokeDialogProps {
  pending: PendingRevoke | null;
  busy: boolean;
  error: unknown;
  scopeNote: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** The confirmation every revoke goes through. */
const RevokeDialog: React.FC<RevokeDialogProps> = ({
  pending,
  busy,
  error,
  scopeNote,
  onCancel,
  onConfirm,
}) => (
  <Dialog
    open={pending !== null}
    onClose={() => {
      if (!busy) onCancel();
    }}
    title={`Revoke access for ${pending?.clientName ?? 'this app'}?`}
    size="sm"
  >
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        {pending?.userLabel === undefined
          ? `${pending?.clientName ?? 'This app'} can no longer act for you ${scopeNote}. It has to be authorized again before it can reach your issues.`
          : `${pending.clientName} can no longer act for ${pending.userLabel} ${scopeNote}. They have to authorize it again before it can reach this workspace.`}
      </p>
      {pending !== null && error !== null && (
        <ErrorAlert message={errorMessage(error, 'Could not revoke access.')} />
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Revoking' : 'Revoke access'}
        </Button>
      </div>
    </div>
  </Dialog>
);

/** The workspaces where an app's grant lacks some of the new permissions. */
const grantedWorkspaces = (app: ConnectedAppRead | null): string =>
  (app?.workspaces ?? [])
    .filter((workspace) => (workspace.new_scopes ?? []).length > 0)
    .map((workspace) => workspace.name || workspace.id)
    .join(', ') || 'your workspaces';

/** Props for GrantDialog: the app whose new permissions are offered and the call that grants them. */
interface GrantDialogProps {
  app: ConnectedAppRead | null;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}

/** The confirmation that lists exactly which new permissions an app gains, and where. */
const GrantDialog: React.FC<GrantDialogProps> = ({
  app,
  busy,
  error,
  onCancel,
  onConfirm,
}) => (
  <Dialog
    open={app !== null}
    onClose={() => {
      if (!busy) onCancel();
    }}
    title={`Grant new permissions to ${app?.client_name ?? 'this app'}?`}
    size="sm"
  >
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        {`${app?.client_name ?? 'This app'} gains these permissions in ${grantedWorkspaces(app)}. It picks them up at its next token refresh, with no need to authorize it again.`}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {(app?.new_scopes ?? []).map((scope) => (
          <li
            key={scope}
            className="rounded-sm border border-line bg-raised px-1.5 py-0.5 font-mono text-xs text-text"
          >
            {scope}
          </li>
        ))}
      </ul>
      {app !== null && error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not grant the new permissions.')}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Granting' : 'Grant permissions'}
        </Button>
      </div>
    </div>
  </Dialog>
);

/** Lists the caller's own connected apps, with a revoke on each and a grant where new permissions exist. */
export const MyConnectedAppsSection: React.FC = () => {
  const auth = useQueryAuth();
  const [pending, setPending] = useState<PendingRevoke | null>(null);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listMyConnectedApps(signal),
    { intervalMs: POLL_MS, queryKey: MY_CONNECTED_APPS_KEY, auth }
  );

  const [revokeError, setRevokeError] = useState<unknown>(null);
  const { mutate: revoke, isMutating } = useMutationWithRefetch(
    (clientId: string) => revokeMyConnectedApp(clientId),
    MY_CONNECTED_APPS_KEY
  );

  const [granting, setGranting] = useState<ConnectedAppRead | null>(null);
  const [grantError, setGrantError] = useState<unknown>(null);
  const { mutate: grant, isMutating: isGranting } = useMutationWithRefetch(
    (target: ConnectedAppRead) =>
      grantMyConnectedAppScopes(target.client_id, target.new_scopes ?? []),
    MY_CONNECTED_APPS_KEY
  );

  const apps: ConnectedAppRead[] = data ?? [];

  const close = (): void => {
    setPending(null);
    setRevokeError(null);
  };

  const closeGrant = (): void => {
    setGranting(null);
    setGrantError(null);
  };

  const onConfirmGrant = (): void => {
    if (granting === null) return;
    void grant(granting)
      .then(() => {
        setGranting(null);
      })
      .catch((failure: unknown) => {
        setGrantError(failure);
      });
  };

  const onConfirm = (): void => {
    if (pending === null) return;
    void revoke(pending.clientId)
      .then(() => {
        setPending(null);
      })
      .catch((failure: unknown) => {
        setRevokeError(failure);
      });
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Connected apps</h2>
        <p className="text-sm text-text-muted">
          Apps you have let act for you, such as an MCP client in your editor.
          Each one works only in the workspaces you chose when you authorized
          it, and only with the access you gave it.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load your connected apps.')}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading your connected apps" />
      ) : apps.length === 0 ? (
        error === null && (
          <div className="rounded-md border border-dashed border-line">
            <EmptyState
              className="py-10"
              icon={<LuPlug />}
              message="No apps are connected to your account. When you authorize one, it shows up here and you can revoke it at any time."
            />
          </div>
        )
      ) : (
        <ul className="rounded-md border border-line">
          {apps.map((app) => (
            <li
              key={app.client_id}
              className={`${COLUMNS} min-h-row border-b border-line py-2 transition-colors duration-100 last:border-b-0 hover:bg-surface`}
            >
              <AppMark name={app.client_name} />
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-medium text-text">
                  {app.client_name}
                </p>
                <p className="truncate text-xs text-text-muted">
                  {app.workspaces
                    .map((workspace) => workspace.name || workspace.id)
                    .join(', ')}
                  <span className="mx-1 text-text-faint">/</span>
                  <span>{app.scopes.join(', ')}</span>
                </p>
                {(app.new_scopes ?? []).length > 0 && (
                  <p className="truncate text-xs text-text-muted">
                    New permissions available:{' '}
                    {(app.new_scopes ?? []).join(', ')}
                  </p>
                )}
                <Timeline
                  authorizedAt={app.first_authorized_at}
                  lastUsedAt={app.last_used_at}
                />
              </div>
              <div className="flex items-center gap-1">
                {(app.new_scopes ?? []).length > 0 && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setGrantError(null);
                      setGranting(app);
                    }}
                  >
                    Grant new permissions
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRevokeError(null);
                    setPending({
                      clientId: app.client_id,
                      clientName: app.client_name,
                    });
                  }}
                >
                  Revoke
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <RevokeDialog
        pending={pending}
        busy={isMutating}
        error={revokeError}
        scopeNote="in any workspace"
        onCancel={close}
        onConfirm={onConfirm}
      />

      <GrantDialog
        app={granting}
        busy={isGranting}
        error={grantError}
        onCancel={closeGrant}
        onConfirm={onConfirmGrant}
      />
    </section>
  );
};

/** Props for WorkspaceConnectedAppsSection: the workspace whose grants are shown. */
export interface WorkspaceConnectedAppsSectionProps {
  workspace: WorkspaceRead;
}

/** The name a member goes by in a row, falling back to their address. */
const memberLabel = (row: WorkspaceConnectedAppRead): string =>
  row.user.display_name || row.user.email || row.user.id;

/** Lists every member's grant in this workspace, for an admin, with a revoke on each. */
export const WorkspaceConnectedAppsSection: React.FC<
  WorkspaceConnectedAppsSectionProps
> = ({ workspace }) => {
  const auth = useQueryAuth();
  const [pending, setPending] = useState<PendingRevoke | null>(null);
  const queryKey = workspaceConnectedAppsKey(workspace.id);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWorkspaceConnectedApps(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const [revokeError, setRevokeError] = useState<unknown>(null);
  const { mutate: revoke, isMutating } = useMutationWithRefetch(
    (target: { userId: string; clientId: string }) =>
      revokeWorkspaceConnectedApp(workspace.id, target.userId, target.clientId),
    queryKey
  );

  const rows: WorkspaceConnectedAppRead[] = data ?? [];

  const close = (): void => {
    setPending(null);
    setRevokeError(null);
  };

  const onConfirm = (): void => {
    if (pending?.userId === undefined) return;
    void revoke({ userId: pending.userId, clientId: pending.clientId })
      .then(() => {
        setPending(null);
      })
      .catch((failure: unknown) => {
        setRevokeError(failure);
      });
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">
          Connected apps in {workspace.name}
        </h2>
        <p className="text-sm text-text-muted">
          Every app a member has authorized in this workspace. Revoking one here
          ends its access to this workspace only.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the connected apps in this workspace.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the workspace's connected apps" />
      ) : rows.length === 0 ? (
        error === null && (
          <p className="text-sm text-text-muted">
            No member has connected an app to this workspace.
          </p>
        )
      ) : (
        <ul className="rounded-md border border-line">
          {rows.map((row) => (
            <li
              key={`${row.user.id}:${row.client_id}`}
              className={`${COLUMNS} min-h-row border-b border-line py-2 transition-colors duration-100 last:border-b-0 hover:bg-surface`}
            >
              <AppMark name={row.client_name} />
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm text-text">
                  <span className="font-medium">{row.client_name}</span>
                  <span className="mx-1 text-text-faint">/</span>
                  <span className="text-text-muted">{memberLabel(row)}</span>
                </p>
                <p className="truncate text-xs text-text-muted">
                  {row.scopes.join(', ')}
                </p>
                <Timeline
                  authorizedAt={row.authorized_at}
                  lastUsedAt={row.last_used_at}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${row.client_name} for ${memberLabel(row)}`}
                onClick={() => {
                  setRevokeError(null);
                  setPending({
                    clientId: row.client_id,
                    clientName: row.client_name,
                    userId: row.user.id,
                    userLabel: memberLabel(row),
                  });
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <RevokeDialog
        pending={pending}
        busy={isMutating}
        error={revokeError}
        scopeNote="in this workspace"
        onCancel={close}
        onConfirm={onConfirm}
      />
    </section>
  );
};

export default MyConnectedAppsSection;
