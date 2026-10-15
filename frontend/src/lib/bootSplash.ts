/**
 * The values the cold start screen shares with the static copy index.html
 * paints before the bundle loads, so the two stay identical.
 */

/** The element id of the static splash index.html paints before the bundle. */
export const STATIC_BOOT_SPLASH_ID = 'boot-splash';

/** One spinner turn, in milliseconds. index.html uses the same period. */
export const BOOT_SPLASH_PERIOD_MS = 800;

/** The rendered size of the mark, in pixels. index.html uses the same size. */
export const BOOT_SPLASH_MARK_SIZE = 40;

/**
 * The spinner's animation delay for an element styled now: minus the time
 * since the page's time origin, modulo one turn, so every splash, static or
 * rendered, shows the same angle at the same moment and a swap never jumps.
 */
export const bootSplashPhase = (now: number = performance.now()): string =>
  `-${Math.round(now % BOOT_SPLASH_PERIOD_MS)}ms`;
