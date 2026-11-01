/**
 * Remembers, in the browser, which app asked to sign in, through the shared store.
 * Only the key is this product's: sign-up, password reset and email verification
 * can leave the handoff page and come back through a mailed link, and this is what
 * still leads back to the app.
 */

import { createDesktopHandoffReturnStore } from '@webbpulse/auth';

/** Where the path is kept in the browser. */
export const APP_HANDOFF_STORAGE_KEY = 'standupless.appHandoffReturn';

/** The handoff page request kept as the way back to the app. */
export const appHandoffReturn = createDesktopHandoffReturnStore({
  storageKey: APP_HANDOFF_STORAGE_KEY,
});
