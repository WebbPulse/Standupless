/**
 * The passkey management section, built on the headless `usePasskeyPanel`
 * state machine. Success copy is this product's; refusal copy is always the
 * server's own sentence, rendered verbatim.
 */

import React from 'react';
import { usePasskeyPanel } from '@webbpulse/auth/panels';
import type { Passkey } from '@webbpulse/auth';
import { LuKeyRound, LuPlus } from 'react-icons/lu';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import EmptyState from '../ui/empty-state';
import Input from '../ui/input';
import Spinner from '../ui/spinner';
import {
  getIdentityClient,
  type IdentityClient,
} from '../../api/identityClient';
import { dateLabel } from '../../lib/accessDisplay';

/** Props for PasskeyRow: the passkey and the panel state it belongs to. */
interface PasskeyRowProps {
  passkey: Passkey;
  panel: ReturnType<typeof usePasskeyPanel>;
}

/** One 36px row: the key icon, the name and date, and the row actions. */
const PasskeyRow: React.FC<PasskeyRowProps> = ({ passkey, panel }) => {
  const renaming = panel.renaming === passkey.credentialId;
  return (
    <li className="flex h-row items-center gap-3 px-3 transition-colors duration-100 hover:bg-surface">
      <LuKeyRound
        className="h-4 w-4 shrink-0 text-text-faint"
        aria-hidden="true"
      />
      {renaming ? (
        <>
          <Input
            aria-label="Passkey name"
            className="h-7 flex-1"
            value={panel.draftRename}
            onChange={(event) => panel.setDraftRename(event.target.value)}
            disabled={panel.busy}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void panel.commitRename()}
            disabled={panel.busy}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={panel.cancelRename}
            disabled={panel.busy}
          >
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate font-medium text-text">
            {passkey.name}
          </span>
          <span className="hidden shrink-0 text-xs text-text-muted sm:inline">
            Added {dateLabel(passkey.createdAt)}
          </span>
          <span className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => panel.startRename(passkey)}
              disabled={panel.busy}
            >
              Rename
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void panel.remove(passkey.credentialId)}
              disabled={panel.busy}
            >
              Remove
            </Button>
          </span>
        </>
      )}
    </li>
  );
};

/**
 * The section itself, mounted only once a client exists so the panel hook
 * always has one to call.
 */
const PasskeyList: React.FC<{ client: IdentityClient }> = ({ client }) => {
  const panel = usePasskeyPanel({
    client,
    messages: {
      created: (passkey) => `Passkey "${passkey.name}" added.`,
      renamed: 'Passkey renamed.',
      removed: 'Passkey removed.',
    },
  });

  if (panel.unavailable) return null;

  const addButton =
    panel.supported && !panel.adding ? (
      <Button variant="primary" size="sm" onClick={panel.startCreate}>
        <LuPlus className="h-3.5 w-3.5" aria-hidden="true" />
        Add a passkey
      </Button>
    ) : null;

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Passkeys</h2>
          <p className="text-sm text-text-muted">
            Sign in with your device instead of a password.
          </p>
        </div>
        {addButton}
      </div>

      <ConfirmationAlert message={panel.notice} />
      <ErrorAlert message={panel.error} />

      {panel.adding && (
        <div className="flex items-center gap-2">
          <Input
            aria-label="New passkey name"
            className="h-7 max-w-xs"
            value={panel.draftName}
            onChange={(event) => panel.setDraftName(event.target.value)}
            placeholder="Name this passkey"
            disabled={panel.busy}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void panel.commitCreate()}
            disabled={panel.busy}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={panel.cancelCreate}
            disabled={panel.busy}
          >
            Cancel
          </Button>
        </div>
      )}

      {panel.loading && <Spinner label="Loading passkeys" />}

      {panel.items !== null && panel.items.length === 0 && !panel.loading && (
        <EmptyState
          message="No passkeys on this account yet."
          icon={<LuKeyRound />}
          className="rounded-md border border-line py-10"
        />
      )}

      {panel.items !== null && panel.items.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {panel.items.map((passkey) => (
            <PasskeyRow
              key={passkey.credentialId}
              passkey={passkey}
              panel={panel}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

/** Renders the passkey section, or nothing when no identity client could be built. */
const PasskeyPanel: React.FC = () => {
  const client = getIdentityClient();
  if (client === null) return null;
  return <PasskeyList client={client} />;
};

export default PasskeyPanel;
