/**
 * The prompt the `@webbpulse/auth` step-up gate asks for when the server
 * refuses a call with `STEP_UP_REQUIRED`. It offers every way the account can
 * prove a recent sign-in: a passkey, the password, or an authenticator or
 * recovery code, plus signing in again through a connected provider for an
 * account that has none of those. A successful proof replays the parked call.
 */

import React, { useState } from 'react';
import type { StepUpGate, StepUpMethod } from '@webbpulse/auth/react';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** A way to sign in again through a provider, as a full page navigation. */
export interface ReauthLink {
  label: string;
  href: string;
}

/** Props for StepUpDialog. */
export interface StepUpDialogProps {
  gate: StepUpGate;
  /** What is being confirmed, finishing "Confirm it is you to ...". */
  action: string;
  reauth: ReauthLink[];
}

/** Which secret the form is asking for. */
type Secret = 'password' | 'code';

/** The verify prompt, open while the gate holds a parked call. */
export const StepUpDialog: React.FC<StepUpDialogProps> = ({
  gate,
  action,
  reauth,
}) => {
  const [secret, setSecret] = useState<Secret>('password');
  const [value, setValue] = useState('');

  const submit = async (method: StepUpMethod): Promise<void> => {
    if (gate.pending) return;
    if (await gate.submit(method)) {
      setValue('');
      setSecret('password');
    }
  };

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (value.trim() === '') return;
    void submit(
      secret === 'password' ? { password: value } : { code: value.trim() }
    );
  };

  const cancel = (): void => {
    if (gate.pending) return;
    setValue('');
    setSecret('password');
    gate.cancel();
  };

  return (
    <Dialog
      open={gate.open}
      onClose={cancel}
      title="Confirm it is you"
      size="sm"
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <p className="text-sm text-text-muted">
          Sign in again to {action}. This keeps someone with your open session
          from changing how you sign in.
        </p>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => void submit({ passkey: true })}
          disabled={gate.pending}
        >
          Use a passkey
        </Button>
        <div className="space-y-2">
          <Field
            id="step-up-secret"
            label={
              secret === 'password'
                ? 'Password'
                : 'Authenticator or recovery code'
            }
            type={secret === 'password' ? 'password' : 'text'}
            value={value}
            autoComplete={
              secret === 'password' ? 'current-password' : 'one-time-code'
            }
            onChange={(event) => setValue(event.target.value)}
            disabled={gate.pending}
          />
          <button
            type="button"
            className="text-xs text-text-muted underline underline-offset-2 hover:text-text disabled:opacity-50"
            onClick={() => {
              setValue('');
              setSecret(secret === 'password' ? 'code' : 'password');
            }}
            disabled={gate.pending}
          >
            {secret === 'password'
              ? 'Use an authenticator or recovery code instead'
              : 'Use your password instead'}
          </button>
        </div>
        {reauth.length > 0 && (
          <div className="space-y-1 border-t border-line pt-3">
            <p className="text-xs text-text-muted">
              No password or code? Sign in again, then come back here.
            </p>
            <ul className="space-y-1">
              {reauth.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="text-sm font-medium text-text underline underline-offset-2 hover:text-text-muted"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorAlert message={gate.error?.message} />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={cancel}
            disabled={gate.pending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={gate.pending || value.trim() === ''}
          >
            Verify
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default StepUpDialog;
