/**
 * SCIM provisioning in the single sign-on settings: the base URL an identity
 * provider connects to and the tokens it connects with.
 *
 * A token's secret comes back once, from the mint, and is shown until it is
 * dismissed. The list only ever carries a prefix, so a lost token is revoked
 * and minted again rather than read back.
 */

import React, { useId, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  createScimToken,
  getScimSettings,
  revokeScimToken,
} from '../../api/workspaces';
import { useCopy } from '../../hooks/useCopy';
import { errorMessage } from '../../lib/errors';
import { workspaceScimKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { ScimTokenCreated, ScimTokenRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Input from '../ui/input';
import Label from '../ui/label';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';

/** Props for ScimBlock: the workspace whose directory provisioning is shown. */
export interface ScimBlockProps {
  workspaceId: string;
}

/** How often the token list is re-read while the tab is open. */
const POLL_MS = 60000;

/** One live token, with when it was last used and a revoke button. */
const TokenRow: React.FC<{
  token: ScimTokenRead;
  busy: boolean;
  onRevoke: (token: ScimTokenRead) => void;
}> = ({ token, busy, onRevoke }) => (
  <li className="flex min-h-row items-center justify-between gap-4 px-3 py-1.5">
    <div className="min-w-0 space-y-0.5">
      <span className="block truncate text-sm font-medium text-text">
        {token.name}
      </span>
      <span className="block text-xs text-text-faint">
        <code className="font-mono">{token.prefix}</code>
        {' · '}
        {token.last_used_at === null ? (
          'Never used'
        ) : (
          <>
            Last used <RelativeTime value={token.last_used_at} />
          </>
        )}
      </span>
    </div>
    <Button
      size="sm"
      variant="secondary"
      disabled={busy}
      onClick={() => {
        onRevoke(token);
      }}
    >
      Revoke
    </Button>
  </li>
);

/** The SCIM base URL, the live tokens, and minting and revoking them. */
export const ScimBlock: React.FC<ScimBlockProps> = ({ workspaceId }) => {
  const auth = useQueryAuth();
  const queryKey = workspaceScimKey(workspaceId);
  const inputId = useId();
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<ScimTokenCreated | null>(null);
  const urlCopy = useCopy();
  const secretCopy = useCopy();
  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getScimSettings(workspaceId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );
  const create = useMutationWithRefetch(
    (value: string) => createScimToken(workspaceId, value),
    [queryKey]
  );
  const revoke = useMutationWithRefetch(
    (keyId: string) => revokeScimToken(workspaceId, keyId),
    [queryKey]
  );
  const busy = create.isMutating || revoke.isMutating;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    try {
      const created = await create.mutate(name.trim() || 'SCIM');
      setMinted(created);
      setName('');
      await refetch();
    } catch {
      return;
    }
  };

  const drop = async (token: ScimTokenRead) => {
    try {
      await revoke.mutate(token.key_id);
      if (minted?.key_id === token.key_id) setMinted(null);
      await refetch();
      showToast(`${token.name} was revoked.`);
    } catch {
      return;
    }
  };

  const tokens = data?.tokens ?? [];

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">Directory provisioning</h3>
        <p className="text-xs text-text-muted">
          Let your identity provider add, update and remove people over SCIM.
          People need an address on a verified domain. Groups link to the team
          with the same name or key, and removing someone in the directory signs
          them out and revokes their API keys.
        </p>
      </div>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load SCIM provisioning.')}
        />
      )}
      {create.error !== null && (
        <ErrorAlert
          message={errorMessage(create.error, 'Could not create the token.')}
        />
      )}
      {revoke.error !== null && (
        <ErrorAlert
          message={errorMessage(revoke.error, 'Could not revoke the token.')}
        />
      )}
      {isLoading && data === null ? (
        <Spinner label="Loading SCIM provisioning" />
      ) : data === null ? null : (
        <>
          <div className="flex min-h-row items-center justify-between gap-3 rounded-md border border-line px-3 py-1.5">
            <div className="min-w-0 space-y-0.5">
              <span className="block text-xs text-text-faint">
                SCIM base URL
              </span>
              <code className="block font-mono text-xs break-all text-text">
                {data.base_url}
              </code>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                urlCopy.copy(data.base_url);
              }}
            >
              {urlCopy.copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {minted !== null && (
            <div
              role="status"
              className="space-y-3 rounded-md border border-success/30 bg-success-soft p-3"
            >
              <p className="text-sm text-text">
                This is the only time the token for {minted.name} is shown. Copy
                it into your identity provider now.
              </p>
              <code className="block overflow-x-auto rounded-sm border border-line bg-bg px-2 py-1 font-mono text-xs text-text">
                {minted.secret}
              </code>
              <div className="flex gap-1.5">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    secretCopy.copy(minted.secret);
                  }}
                >
                  {secretCopy.copied ? 'Copied' : 'Copy token'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMinted(null);
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          <ul
            aria-label="SCIM tokens"
            className="divide-y divide-line rounded-md border border-line"
          >
            {tokens.length === 0 && (
              <li className="flex min-h-row items-center px-3 py-2 text-sm text-text-muted">
                No SCIM tokens yet.
              </li>
            )}
            {tokens.map((token) => (
              <TokenRow
                key={token.key_id}
                token={token}
                busy={busy}
                onRevoke={(value) => {
                  void drop(value);
                }}
              />
            ))}
            <li className="px-3 py-2">
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  void submit(event);
                }}
              >
                <Label htmlFor={inputId} hidden>
                  Token name
                </Label>
                <Input
                  id={inputId}
                  placeholder="Okta"
                  maxLength={80}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                >
                  Create token
                </Button>
              </form>
            </li>
          </ul>
        </>
      )}
    </div>
  );
};

export default ScimBlock;
