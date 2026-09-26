/**
 * A fresh proof of identity before a destructive action, on the step-up routes
 * `@webbpulse/auth` already serves. A passkey is tried first; an account with
 * none, or a browser without WebAuthn, is asked for an authenticator or
 * recovery code instead. The server records whether the action was stepped up
 * rather than refusing one that was not, because an account with only a
 * password has no second factor to prove, so `skip` lets that person carry on
 * with the typed confirmation alone.
 */

import { useCallback, useState } from 'react';
import { getIdentityClient } from '../api/identityClient';

/** Where the step-up stands: not started, waiting on a code, or proven. */
export type StepUpStage = 'idle' | 'code' | 'done';

/** The step-up state and the three ways a page moves it along. */
export interface StepUpState {
  stage: StepUpStage;
  busy: boolean;
  error: string | null;
  /** Tries a passkey, moving to `code` when the account or browser has none. Resolves true once proven. */
  withPasskey: () => Promise<boolean>;
  /** Verifies an authenticator or recovery code. Resolves true once proven. */
  withCode: (code: string) => Promise<boolean>;
  /** Carries on with no second factor, for an account that has none. */
  skip: () => void;
  /** Starts over, for a dialog that was closed. */
  reset: () => void;
}

/** Tracks one step-up from first attempt to proof. */
export const useStepUp = (): StepUpState => {
  const [stage, setStage] = useState<StepUpStage>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withPasskey = useCallback(async (): Promise<boolean> => {
    const client = getIdentityClient();
    if (client === null) {
      setStage('code');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await client.stepUpWithPasskey();
      if (outcome.ok) {
        setStage('done');
        return true;
      }
      if (
        outcome.reason === 'no-passkeys' ||
        outcome.reason === 'unsupported'
      ) {
        setStage('code');
        return false;
      }
      if (outcome.reason !== 'cancelled') setError(outcome.message);
      setStage('code');
      return false;
    } catch {
      setStage('code');
      setError('Could not check your passkey. Try a code instead.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const withCode = useCallback(async (code: string): Promise<boolean> => {
    const client = getIdentityClient();
    if (client === null) {
      setError('Sign in again to confirm this.');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await client.stepUp({ code: code.trim() });
      if (outcome.ok) {
        setStage('done');
        return true;
      }
      setError(outcome.message);
      return false;
    } catch {
      setError('Could not check that code.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const skip = useCallback(() => {
    setError(null);
    setStage('done');
  }, []);

  const reset = useCallback(() => {
    setStage('idle');
    setBusy(false);
    setError(null);
  }, []);

  return { stage, busy, error, withPasskey, withCode, skip, reset };
};
