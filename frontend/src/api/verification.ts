/**
 * Moves a signed in session onto a token that carries a confirmed address.
 */

import { getIdentityClient } from './identityClient';

/**
 * Rotates the access token so it carries the confirmed address, then reads the
 * profile again. The rotation comes first so the pages that mount once the
 * profile says verified hold a token the API accepts.
 */
export const recheckVerification = async (
  checkAuthStatus: () => Promise<void>
): Promise<void> => {
  const client = getIdentityClient();
  if (client === null) return;
  const token = await client.refresh();
  if (token === null) return;
  await checkAuthStatus();
};
