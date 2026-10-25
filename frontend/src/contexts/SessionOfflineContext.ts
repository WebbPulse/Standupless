/**
 * Whether the signed in session is riding out a network outage: a token
 * refresh failed because the network was down, so the person stays signed in
 * and `@webbpulse/auth` parks an `ApiNetworkError` in its state. Kept apart
 * from the provider so the provider file exports only components and stays
 * refresh safe. Reads false outside the auth provider.
 */

import { createContext } from 'react';

/** True while the session's last refresh failed at the network layer. */
export const SessionOfflineContext = createContext(false);
