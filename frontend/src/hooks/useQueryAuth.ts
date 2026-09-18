/**
 * Hands the identity client to `usePolledQuery` as its `auth` option, so a
 * query mounted during boot waits for the restored session rather than going
 * out anonymous and rendering a 401.
 */

import { useMemo } from 'react';
import type { AuthTokenProvider } from '@webbpulse/api-client';
import { getIdentityClient } from '../api/identityClient';

/** The token waiter a polled query takes, or undefined with no identity client. */
export const useQueryAuth = ():
  Pick<AuthTokenProvider, 'waitForToken'> | undefined =>
  useMemo(() => {
    const client = getIdentityClient();
    return client === null
      ? undefined
      : { waitForToken: () => client.waitForToken() };
  }, []);
