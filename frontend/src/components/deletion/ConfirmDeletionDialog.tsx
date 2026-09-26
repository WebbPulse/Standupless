/**
 * The speed bumps in front of a scheduled deletion, shared by the workspace
 * and the account: what goes, the name or address typed out again, and a
 * fresh passkey or code before the request is sent. Nothing is deleted when
 * this confirms, only scheduled, and the dialog says so.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStepUp } from '../../hooks/useStepUp';
import { confirmationMatches } from '../../lib/deletion';
import { errorMessage } from '../../lib/errors';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** Props for ConfirmDeletionDialog. */
export interface ConfirmDeletionDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What is deleted and when, shown above the typed confirmation. */
  children: React.ReactNode;
  /** The label on the confirmation field, naming what to type. */
  confirmLabel: string;
  /** The text that has to be typed out again. */
  expected: string;
  /** Whether case is ignored when matching, as it is for an email address. */
  ignoreCase?: boolean;
  /** The label on the final button. */
  submitLabel: string;
  /** Sends the request with the typed text, throwing on refusal. */
  onConfirm: (typed: string) => Promise<void>;
  /** The sentence shown when the request is refused without one of its own. */
  failureMessage: string;
}

/** A typed confirmation followed by a step-up, then the scheduling request. */
export const ConfirmDeletionDialog: React.FC<ConfirmDeletionDialogProps> = ({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  expected,
  ignoreCase = false,
  submitLabel,
  onConfirm,
  failureMessage,
}) => {
  const stepUp = useStepUp();
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const matches = confirmationMatches(typed, expected, ignoreCase);
  const busy = sending || stepUp.busy;

  const closeRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    closeRef.current = () => {
      if (busy) return;
      setTyped('');
      setCode('');
      setFailure(null);
      stepUp.reset();
      onClose();
    };
  });
  const close = useCallback(() => closeRef.current(), []);

  const send = async (): Promise<void> => {
    setSending(true);
    setFailure(null);
    try {
      await onConfirm(typed.trim());
      setTyped('');
      setCode('');
      stepUp.reset();
      onClose();
    } catch (error) {
      setFailure(errorMessage(error, failureMessage));
    } finally {
      setSending(false);
    }
  };

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!matches || busy) return;
    if (stepUp.stage === 'done') {
      await send();
      return;
    }
    const proven =
      stepUp.stage === 'code'
        ? await stepUp.withCode(code)
        : await stepUp.withPasskey();
    if (proven) await send();
  };

  const onSkip = async (): Promise<void> => {
    if (!matches || busy) return;
    stepUp.skip();
    await send();
  };

  return (
    <Dialog open={open} onClose={close} title={title}>
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
        <div className="space-y-2 text-sm text-text-muted">{children}</div>
        <Field
          id="deletion-confirmation"
          label={confirmLabel}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
          disabled={busy}
        />
        {stepUp.stage === 'code' && (
          <div className="space-y-2">
            <Field
              id="deletion-step-up-code"
              label="Authenticator or recovery code"
              hint="Confirm it is you. Use a code from your authenticator app, or one of your recovery codes."
              value={code}
              autoComplete="one-time-code"
              onChange={(event) => setCode(event.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="text-xs text-text-muted underline underline-offset-2 hover:text-text disabled:opacity-50"
              onClick={() => void onSkip()}
              disabled={!matches || busy}
            >
              I do not use a passkey or an authenticator app
            </button>
          </div>
        )}
        <ErrorAlert message={stepUp.error} />
        <ErrorAlert message={failure} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={
              !matches ||
              busy ||
              (stepUp.stage === 'code' && code.trim() === '')
            }
          >
            {stepUp.stage === 'code' ? 'Verify and schedule' : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default ConfirmDeletionDialog;
