/**
 * The passkey management list, built on the headless `usePasskeyPanel` state
 * machine. Success copy is this product's; refusal copy is always the server's
 * own sentence, rendered verbatim.
 */

import React from 'react';
import { usePasskeyPanel } from '@webbpulse/auth/panels';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Input from '../ui/input';
import Spinner from '../ui/spinner';
import {
  getIdentityClient,
  type IdentityClient,
} from '../../api/identityClient';

/**
 * The list itself, mounted only once a client exists so the panel hook always
 * has one to call.
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

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-100">Passkeys</h2>
        {panel.supported && !panel.adding && (
          <Button variant="secondary" onClick={panel.startCreate}>
            Add a passkey
          </Button>
        )}
      </div>

      <ConfirmationAlert message={panel.notice} />
      <ErrorAlert message={panel.error} />

      {panel.adding && (
        <div className="flex gap-2">
          <Input
            aria-label="New passkey name"
            value={panel.draftName}
            onChange={(event) => panel.setDraftName(event.target.value)}
            placeholder="Name this passkey"
            disabled={panel.busy}
          />
          <Button
            onClick={() => void panel.commitCreate()}
            disabled={panel.busy}
          >
            Save
          </Button>
          <Button
            variant="secondary"
            onClick={panel.cancelCreate}
            disabled={panel.busy}
          >
            Cancel
          </Button>
        </div>
      )}

      {panel.loading && <Spinner label="Loading passkeys" />}

      {panel.items !== null && panel.items.length === 0 && !panel.loading && (
        <p className="text-sm text-slate-400">
          No passkeys on this account yet.
        </p>
      )}

      <ul className="space-y-2">
        {panel.items?.map((passkey) => (
          <li
            key={passkey.credentialId}
            className="flex items-center justify-between gap-2 rounded-md border border-slate-700 px-3 py-2"
          >
            {panel.renaming === passkey.credentialId ? (
              <>
                <Input
                  aria-label="Passkey name"
                  value={panel.draftRename}
                  onChange={(event) => panel.setDraftRename(event.target.value)}
                  disabled={panel.busy}
                />
                <Button
                  onClick={() => void panel.commitRename()}
                  disabled={panel.busy}
                >
                  Save
                </Button>
                <Button
                  variant="secondary"
                  onClick={panel.cancelRename}
                  disabled={panel.busy}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <span className="text-sm text-slate-100">{passkey.name}</span>
                <span className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => panel.startRename(passkey)}
                    disabled={panel.busy}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void panel.remove(passkey.credentialId)}
                    disabled={panel.busy}
                  >
                    Remove
                  </Button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Renders the passkey list, or nothing when no identity client could be built. */
const PasskeyPanel: React.FC = () => {
  const client = getIdentityClient();
  if (client === null) return null;
  return <PasskeyList client={client} />;
};

export default PasskeyPanel;
