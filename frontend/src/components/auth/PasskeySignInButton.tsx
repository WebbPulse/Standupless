/**
 * The passkey sign-in button, hidden unless the browser supports WebAuthn and
 * the deployment enables passwordless sign in. `usePasskeySignInSupport` answers
 * both questions and reports whether the browser can also put a passkey in its
 * email autofill dropdown.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PasskeySignInOutcome } from '@webbpulse/auth';
import { usePasskeySignInSupport } from '@webbpulse/auth/react';
import { FaKey } from 'react-icons/fa';
import {
  PASSKEY_AVAILABILITY_PATH,
  getIdentityClient,
  identityUrl,
  passkeyLoginAvailability,
} from '../../api/identityClient';
import Button from '../ui/button';

/** Props for PasskeySignInButton: the email hint and the outcome callback. */
export interface PasskeySignInButtonProps {
  /** Whatever is in the email field, so a known user skips the chooser. */
  email?: string;
  /** Called for every outcome except a cancellation, which is silent. */
  onResult: (result: PasskeySignInOutcome) => void | Promise<void>;
  disabled?: boolean;
  /** Whether to arm conditional mediation on mount. Off in tests by default. */
  conditional?: boolean;
}

/** A button that runs a passkey ceremony, or nothing when it is not offered. */
const PasskeySignInButton: React.FC<PasskeySignInButtonProps> = ({
  email,
  onResult,
  disabled = false,
  conditional = true,
}) => {
  const [busy, setBusy] = useState(false);
  const client = getIdentityClient();
  const handler = useRef(onResult);
  handler.current = onResult;

  const probe = useCallback(
    () => passkeyLoginAvailability(identityUrl(PASSKEY_AVAILABILITY_PATH)),
    []
  );
  const support = usePasskeySignInSupport({
    probe,
    enabled: client !== null,
  });
  const armed = conditional && support.conditional && client !== null;

  useEffect(() => {
    if (!armed || client === null) return;
    const controller = new AbortController();
    void client
      .signInWithPasskey({
        mediation: 'conditional',
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) return;
        void handler.current(result);
      });
    return () => {
      controller.abort();
    };
  }, [armed, client]);

  if (client === null || !support.offered) return null;

  const handleClick = async () => {
    setBusy(true);
    try {
      const trimmed = email?.trim() ?? '';
      const result = await client.signInWithPasskey(
        trimmed === ''
          ? { mediation: 'optional' }
          : { email: trimmed, mediation: 'optional' }
      );
      if (!result.ok && result.reason === 'cancelled') return;
      await handler.current(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="secondary"
      className="w-full"
      onClick={() => void handleClick()}
      disabled={disabled || busy}
    >
      <FaKey />
      <span>
        {busy ? 'Waiting for your passkey' : 'Sign in with a passkey'}
      </span>
    </Button>
  );
};

export default PasskeySignInButton;
