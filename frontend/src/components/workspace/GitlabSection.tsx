/**
 * The GitLab groups and projects a workspace receives merge request events
 * from, so a merge request naming an issue key links to that issue and moves
 * it as it opens and merges, the way a GitHub pull request does.
 *
 * Connecting takes a GitLab access token with the read_api scope, which the
 * server checks against GitLab and stores sealed, and answers a webhook URL
 * and secret for the admin to add in GitLab. The secret is returned by the
 * connect and rotate calls and by nothing else, so it is held in state and
 * shown until dismissed. A rotate takes effect at once, so it asks first and
 * says so.
 */

import React, { useState } from 'react';
import { LuEllipsis, LuPlus, LuRotateCw, LuTrash2 } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createGitlabConnection,
  deleteGitlabConnection,
  listGitlabConnections,
  rotateGitlabSecret,
} from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { gitlabConnectionsKey } from '../../lib/queryKeys';
import type {
  GitlabConnectionCreated,
  GitlabConnectionRead,
  GitlabConnectionWrite,
  GitlabScopeKind,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { Menu, MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for GitlabSection: the workspace whose GitLab connections are shown. */
export interface GitlabSectionProps {
  workspaceId: string;
}

/** How often the connections are re-read while the page is open. */
const POLL_MS = 60000;

/** A connection waiting on a confirm, and which action it is. */
interface ConfirmState {
  kind: 'rotate' | 'delete';
  connection: GitlabConnectionRead;
}

/** The instance a connection points at, without the scheme, for its row. */
const instanceLabel = (url: string): string => url.replace(/^https:\/\//, '');

/** The connect form: instance, group or project, its path and the token. */
const ConnectDialog: React.FC<{
  saving: boolean;
  error: unknown;
  onSave: (body: GitlabConnectionWrite) => Promise<void>;
  onClose: () => void;
}> = ({ saving, error, onSave, onClose }) => {
  const [instanceUrl, setInstanceUrl] = useState('');
  const [scopeKind, setScopeKind] = useState<GitlabScopeKind>('group');
  const [scopePath, setScopePath] = useState('');
  const [token, setToken] = useState('');
  const ready = scopePath.trim() !== '' && token.trim() !== '';

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!ready || saving) return;
    void onSave({
      instance_url: instanceUrl.trim(),
      scope_kind: scopeKind,
      scope_path: scopePath.trim(),
      access_token: token.trim(),
    }).catch(() => undefined);
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Connect GitLab"
      description="Merge requests in this group or project that name an issue key link to the issue and move it as they open and merge."
      size="md"
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field
          id="gitlab-instance"
          label="GitLab URL"
          placeholder="https://gitlab.com"
          hint="Leave empty for gitlab.com, or enter your self-managed instance."
          value={instanceUrl}
          onChange={(event) => {
            setInstanceUrl(event.target.value);
          }}
        />
        <SelectField
          id="gitlab-scope-kind"
          label="Connect a"
          value={scopeKind}
          onChange={(event) => {
            setScopeKind(event.target.value as GitlabScopeKind);
          }}
        >
          <option value="group">Group, with every project under it</option>
          <option value="project">Single project</option>
        </SelectField>
        <Field
          id="gitlab-scope-path"
          label={scopeKind === 'group' ? 'Group path' : 'Project path'}
          placeholder={
            scopeKind === 'group' ? 'my-group' : 'my-group/my-project'
          }
          value={scopePath}
          onChange={(event) => {
            setScopePath(event.target.value);
          }}
          required
        />
        <Field
          id="gitlab-token"
          label="Access token"
          type="password"
          autoComplete="off"
          hint="A group, project or personal access token with the read_api scope. It is stored encrypted and never shown again."
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
          }}
          required
        />
        {error !== null && error !== undefined && (
          <ErrorAlert
            message={errorMessage(error, 'Could not connect to GitLab.')}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || saving}>
            {saving ? 'Connecting' : 'Connect'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** The webhook URL and the one-time secret, with where they go in GitLab. */
const RevealedSecret: React.FC<{
  connection: GitlabConnectionCreated;
  onDismiss: () => void;
}> = ({ connection, onDismiss }) => {
  const [copied, setCopied] = useState<'url' | 'secret' | null>(null);

  const copy = (what: 'url' | 'secret', text: string): void => {
    void globalThis.navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(what);
      })
      .catch(() => undefined);
  };

  return (
    <div
      role="status"
      className="space-y-3 rounded-md border border-success/30 bg-success-soft p-3"
    >
      <p className="text-sm text-text">
        In GitLab, open {connection.scope_path}, go to Settings, then Webhooks,
        and add a webhook with this URL and secret token, with merge request
        events checked. The secret is shown once, so copy it now.
      </p>
      <div className="space-y-1">
        <p className="text-xs font-medium text-text-muted">URL</p>
        <code className="block overflow-x-auto rounded-sm border border-line bg-bg px-2 py-1 font-mono text-xs text-text">
          {connection.webhook_url}
        </code>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-text-muted">Secret token</p>
        <code className="block overflow-x-auto rounded-sm border border-line bg-bg px-2 py-1 font-mono text-xs text-text">
          {connection.webhook_secret}
        </code>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          onClick={() => {
            copy('url', connection.webhook_url);
          }}
        >
          {copied === 'url' ? 'Copied' : 'Copy URL'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            copy('secret', connection.webhook_secret);
          }}
        >
          {copied === 'secret' ? 'Copied' : 'Copy secret'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
};

/** Lists, connects, rotates and removes the workspace's GitLab connections. */
export const GitlabSection: React.FC<GitlabSectionProps> = ({
  workspaceId,
}) => {
  const auth = useQueryAuth();
  const queryKey = gitlabConnectionsKey(workspaceId);
  const [connecting, setConnecting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [revealed, setRevealed] = useState<GitlabConnectionCreated | null>(
    null
  );

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listGitlabConnections(workspaceId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: create,
    isMutating: creating,
    error: createError,
  } = useMutationWithRefetch(
    (body: GitlabConnectionWrite) => createGitlabConnection(workspaceId, body),
    queryKey
  );

  const {
    mutate: rotate,
    isMutating: rotating,
    error: rotateError,
  } = useMutationWithRefetch(
    (connectionId: string) => rotateGitlabSecret(workspaceId, connectionId),
    queryKey
  );

  const {
    mutate: remove,
    isMutating: removing,
    error: removeError,
  } = useMutationWithRefetch(
    (connectionId: string) => deleteGitlabConnection(workspaceId, connectionId),
    queryKey
  );

  const onSave = async (body: GitlabConnectionWrite): Promise<void> => {
    const created = await create(body);
    setConnecting(false);
    setRevealed(created);
  };

  const onConfirm = (): void => {
    if (confirm === null) return;
    const { connection } = confirm;
    if (confirm.kind === 'rotate') {
      void rotate(connection.connection_id)
        .then((result) => {
          setConfirm(null);
          setRevealed(result);
        })
        .catch(() => undefined);
      return;
    }
    void remove(connection.connection_id)
      .then(() => {
        setConfirm(null);
        if (revealed?.connection_id === connection.connection_id) {
          setRevealed(null);
        }
      })
      .catch(() => undefined);
  };

  const configured = data?.configured === true;
  const connections = data?.connections ?? [];
  const confirmBusy = rotating || removing;
  const confirmError = confirm?.kind === 'rotate' ? rotateError : removeError;

  return (
    <section className="space-y-4" aria-labelledby="gitlab-heading">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 id="gitlab-heading" className="text-base font-semibold">
            GitLab
          </h3>
          <p className="text-sm text-text-muted">
            Link GitLab merge requests to the issues they name, and move those
            issues as the merge requests open and merge, by the same rules as
            GitHub pull requests.
          </p>
        </div>
        {configured && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setConnecting(true);
            }}
          >
            <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
            Connect GitLab
          </Button>
        )}
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the GitLab connections.'
          )}
        />
      )}

      {revealed !== null && (
        <RevealedSecret
          connection={revealed}
          onDismiss={() => {
            setRevealed(null);
          }}
        />
      )}

      {isLoading || data === null ? (
        error === null && <Spinner label="Loading GitLab connections" />
      ) : !configured ? (
        <p className="text-sm text-text-muted">
          This environment cannot store GitLab tokens yet.
        </p>
      ) : connections.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-6 text-center">
          <p className="text-sm text-text-muted">No GitLab connections yet.</p>
          <p className="mt-1 text-xs text-text-faint">
            Connect a group or project to link its merge requests to issues.
          </p>
        </div>
      ) : (
        <ul
          aria-label="GitLab connections"
          className="rounded-md border border-line"
        >
          {connections.map((connection) => (
            <li
              key={connection.connection_id}
              className="flex min-h-row items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">
                    {connection.scope_path}
                  </span>
                  <Badge tone="neutral">
                    {connection.scope_kind === 'group' ? 'Group' : 'Project'}
                  </Badge>
                </div>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-faint">
                  <span>{instanceLabel(connection.instance_url)}</span>
                  {connection.token_hint !== '' && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>token ending {connection.token_hint}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    Connected <RelativeTime value={connection.connected_at} />
                  </span>
                </p>
                <p className="truncate font-mono text-xs text-text-muted">
                  {connection.webhook_url}
                </p>
              </div>
              <Menu
                label={`${connection.scope_path} actions`}
                align="end"
                trigger={(props) => (
                  <IconButton
                    label={`${connection.scope_path} actions`}
                    size="sm"
                    {...props}
                  >
                    <LuEllipsis className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              >
                <MenuItem
                  onSelect={() => {
                    setConfirm({ kind: 'rotate', connection });
                  }}
                >
                  <LuRotateCw aria-hidden="true" className="h-3.5 w-3.5" />
                  Rotate secret
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={() => {
                    setConfirm({ kind: 'delete', connection });
                  }}
                >
                  <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Disconnect
                </MenuItem>
              </Menu>
            </li>
          ))}
        </ul>
      )}

      {connecting && (
        <ConnectDialog
          saving={creating}
          error={createError}
          onSave={onSave}
          onClose={() => {
            setConnecting(false);
          }}
        />
      )}

      <Dialog
        open={confirm !== null}
        onClose={() => {
          if (!confirmBusy) setConfirm(null);
        }}
        title={
          confirm?.kind === 'rotate'
            ? 'Rotate webhook secret?'
            : 'Disconnect GitLab?'
        }
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {confirm?.kind === 'rotate'
              ? `A new secret replaces the current one for ${confirm.connection.scope_path} at once. Deliveries carrying the old one are refused, so update the webhook in GitLab straight away.`
              : `Merge requests in ${confirm?.connection.scope_path ?? 'this group'} stop linking to issues and the stored token is removed. Links already made stay on their issues.`}
          </p>
          {confirm !== null && confirmError !== null && (
            <ErrorAlert
              message={errorMessage(
                confirmError,
                confirm.kind === 'rotate'
                  ? 'Could not rotate that secret.'
                  : 'Could not disconnect GitLab.'
              )}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant={confirm?.kind === 'rotate' ? 'primary' : 'danger'}
              disabled={confirmBusy}
              onClick={onConfirm}
            >
              {confirm?.kind === 'rotate'
                ? rotating
                  ? 'Rotating'
                  : 'Rotate secret'
                : removing
                  ? 'Disconnecting'
                  : 'Disconnect'}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
};

export default GitlabSection;
