/**
 * The log out shortcut, shared by the global binding, the palette row and the
 * workspace menu so all three show and run the same keys. Kept apart from the
 * auth hook so the many tests that mock that hook still see the keys.
 */

/** The keys that log out from anywhere in a workspace, as in Linear. */
export const LOG_OUT_KEYS = 'alt+shift+q';
