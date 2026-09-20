/**
 * The API keys of one workspace.
 *
 * The secret is the whole reason this surface is shaped the way it is. It comes
 * back from the mint and from nothing else, the stored row holds only its hash,
 * and there is no support path that can recover it, so it is held in state and
 * shown until dismissed with copy that says plainly it will not be shown again.
 *
 * The `workspace` listing and the workspace key kind are offered only to an
 * admin, because the server refuses both to anyone else and an empty panel
 * behind a refused read is worse than a control that was never there.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { createApiKey, listApiKeys, revokeApiKey } from '../../api/access';
import { canManageMembers } from '../../lib/capabilities';
import {
  MAX_EXPIRY_DAYS,
  MIN_EXPIRY_DAYS,
  dateLabel,
  keyStateLabel,
  kindLabel,
  parseExpiryDays,
} from '../../lib/accessDisplay';
import { errorMessage } from '../../lib/errors';
import { apiKeysKey } from '../../lib/queryKeys';
import {
  API_KEY_SCOPES,
  type ApiKeyCreatedRead,
  type ApiKeyKind,
  type ApiKeyListScope,
  type ApiKeyScope,
  type WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Field from '../ui/field';
import Spinner from '../ui/spinner';
import { SelectField } from '../ui/select';

/** Props for ApiKeysSection: the workspace whose keys are shown. */
export interface ApiKeysSectionProps {
  workspace: WorkspaceRead;
}

/** How often the key list is re-read while the page is open. */
const POLL_MS = 60000;

/** The column layout the header and every row share. */
const COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3';

/** The badge tone for a key's state label. */
const stateTone = (
  state: ReturnType<typeof keyStateLabel>
): 'success' | 'danger' | 'warning' =>
  state === 'Active' ? 'success' : state === 'Revoked' ? 'danger' : 'warning';

/** Lists and mints API keys, and shows a new secret once. */
export const ApiKeysSection: React.FC<ApiKeysSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const isAdmin = canManageMembers(workspace.role);
  const [scope, setScope] = useState<ApiKeyListScope>('mine');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ApiKeyKind>('user');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['issues:read']);
  const [expiry, setExpiry] = useState('');
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [minted, setMinted] = useState<ApiKeyCreatedRead | null>(null);
  const [copied, setCopied] = useState(false);

  const queryKey = apiKeysKey(workspace.id, scope);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listApiKeys(workspace.id, { scope }, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: mint,
    isMutating,
    error: mintError,
  } = useMutationWithRefetch(
    (body: {
      name: string;
      scopes: string[];
      kind?: ApiKeyKind;
      expires_in_days?: number;
    }) => createApiKey(workspace.id, body),
    queryKey
  );

  const { mutate: revoke, error: revokeError } = useMutationWithRefetch(
    (keyId: string) => revokeApiKey(workspace.id, keyId),
    queryKey
  );

  const canSubmit = name.trim() !== '' && scopes.length > 0 && !isMutating;

  const toggleScope = (value: ApiKeyScope): void => {
    setScopes((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    );
  };

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const parsed = parseExpiryDays(expiry);
    if (!parsed.ok) {
      setExpiryError(parsed.message);
      return;
    }
    setExpiryError(null);
    void mint({
      name: name.trim(),
      scopes: [...scopes],
      ...(kind === 'workspace' ? { kind } : {}),
      ...(parsed.days === undefined ? {} : { expires_in_days: parsed.days }),
    })
      .then((result) => {
        setMinted(result);
        setCopied(false);
        setName('');
        setScopes(['issues:read']);
        setExpiry('');
        setKind('user');
      })
      .catch(() => undefined);
  };

  const onCopy = (): void => {
    const secret = minted?.secret;
    if (secret === undefined) return;
    void globalThis.navigator.clipboard
      ?.writeText(secret)
      .then(() => {
        setCopied(true);
      })
      .catch(() => undefined);
  };

  const keys = data ?? [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">API keys</h2>
          <p className="text-sm text-text-muted">
            A key spends the scopes it was minted with, narrowed by what your
            membership allows at the time of the call. No key can change who is
            in this workspace or mint another key.
          </p>
        </div>
        {isAdmin && (
          <SelectField
            id="api-keys-scope"
            label="Show"
            hideLabel
            className="w-44"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as ApiKeyListScope);
            }}
          >
            <option value="mine">My keys</option>
            <option value="workspace">Every key in this workspace</option>
          </SelectField>
        )}
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the API keys.')}
        />
      )}
      {revokeError !== null && (
        <ErrorAlert
          message={errorMessage(revokeError, 'Could not revoke that key.')}
        />
      )}

      {minted !== null && (
        <div
          role="status"
          className="space-y-3 rounded-md border border-success/30 bg-success-soft p-3"
        >
          <p className="text-sm text-text">
            This is the only time the key for {minted.name} is shown. Copy it
            now. It is stored as a hash, so nothing can read it again and a lost
            key has to be revoked and minted afresh.
          </p>
          <code className="block overflow-x-auto rounded-sm border border-line bg-bg px-2 py-1 font-mono text-xs text-text">
            {minted.secret}
          </code>
          <div className="flex gap-1.5">
            <Button variant="primary" size="sm" onClick={onCopy}>
              {copied ? 'Copied' : 'Copy key'}
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

      {isLoading ? (
        <Spinner label="Loading API keys" />
      ) : keys.length === 0 ? (
        <p className="text-sm text-text-muted">There are no API keys yet.</p>
      ) : (
        <div className="rounded-md border border-line">
          <div
            className={`${COLUMNS} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
          >
            <span>Key</span>
            <span>Status</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul>
            {keys.map((item) => {
              const state = keyStateLabel(item);
              return (
                <li
                  key={item.key_id}
                  className={`${COLUMNS} min-h-row border-b border-line py-1.5 transition-colors duration-100 last:border-b-0 hover:bg-surface`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-text">
                        {item.name}
                      </span>
                      <span className="font-mono text-xs text-text-faint">
                        {item.prefix}
                      </span>
                    </div>
                    <p className="truncate text-xs text-text-muted">
                      {kindLabel(item.kind)}
                      <span className="mx-1 text-text-faint">/</span>
                      <span>{item.scopes.join(', ')}</span>
                    </p>
                    <p className="text-xs text-text-faint">
                      Created {dateLabel(item.created_at)}, last used{' '}
                      {dateLabel(item.last_used_at)}, expires{' '}
                      {item.expires_at === null
                        ? 'never'
                        : dateLabel(item.expires_at)}
                    </p>
                  </div>
                  <Badge tone={stateTone(state)}>{state}</Badge>
                  <div className="flex w-16 justify-end">
                    {item.revoked_at === null && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void revoke(item.key_id).catch(() => undefined);
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <form
        className="space-y-4 rounded-md border border-line p-4"
        onSubmit={onSubmit}
      >
        <h3 className="text-sm font-medium">Mint a key</h3>

        {mintError !== null && (
          <ErrorAlert
            message={errorMessage(mintError, 'Could not mint the key.')}
          />
        )}
        <ErrorAlert message={expiryError} />

        <div className="max-w-md space-y-4">
          <Field
            id="api-key-name"
            label="Name"
            value={name}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />

          {isAdmin && (
            <SelectField
              id="api-key-kind"
              label="Kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as ApiKeyKind);
              }}
            >
              <option value="user">Personal key, acts as you</option>
              <option value="workspace">
                Workspace key, outlives your membership
              </option>
            </SelectField>
          )}

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-text-muted">
              Scopes
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {API_KEY_SCOPES.map((value) => (
                <Checkbox
                  key={value}
                  label={value}
                  checked={scopes.includes(value)}
                  onChange={() => {
                    toggleScope(value);
                  }}
                />
              ))}
            </div>
          </fieldset>

          <Field
            id="api-key-expiry"
            label={`Expires in days, ${String(MIN_EXPIRY_DAYS)} to ${String(MAX_EXPIRY_DAYS)}, blank for never`}
            type="number"
            min={MIN_EXPIRY_DAYS}
            max={MAX_EXPIRY_DAYS}
            value={expiry}
            autoComplete="off"
            className="w-40"
            onChange={(event) => {
              setExpiry(event.target.value);
            }}
          />
        </div>

        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {isMutating ? 'Minting' : 'Mint key'}
        </Button>
      </form>
    </section>
  );
};

export default ApiKeysSection;
