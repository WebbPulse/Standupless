/**
 * Recovery from a code chunk that no longer exists. Every deploy prunes the
 * previous build's hashed files, and the CDN answers a missing one with the
 * SPA shell, so a tab opened before a deploy fails the first lazy import it
 * makes. Reloading picks up the new build. The reload happens once per
 * window, so a chunk that keeps failing shows an error instead of looping.
 */

/** Where the time of the last chunk reload is kept for this tab. */
export const CHUNK_RELOAD_STORAGE_KEY = 'standupless.chunkReloadAt';

/** How long after one chunk reload another is refused, in milliseconds. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

/** What browsers and Vite say when a dynamic import or its preload fails. */
const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /is not a valid javascript mime type/i,
  /loading (css )?chunk [\w-]+ failed/i,
];

/** Whether a thrown value is a code chunk that failed to load. */
export const isChunkLoadError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
};

/** Reads when this tab last reloaded for a chunk, or null. */
const lastReloadAt = (): number | null => {
  try {
    const raw = globalThis.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};

/** Records a chunk reload, reporting whether it could be recorded. */
const recordReload = (now: number): boolean => {
  try {
    globalThis.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));
    return true;
  } catch {
    return false;
  }
};

/**
 * Reloads the page to pick up the current build, unless this tab already did
 * so within the window or cannot remember that it did. Returns whether a
 * reload was started.
 */
export const reloadOnceForChunkError = (
  reload: () => void = () => {
    globalThis.location.reload();
  },
  now: number = Date.now()
): boolean => {
  const last = lastReloadAt();
  if (last !== null && now - last < CHUNK_RELOAD_WINDOW_MS) return false;
  if (!recordReload(now)) return false;
  reload();
  return true;
};
