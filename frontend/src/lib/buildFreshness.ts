/**
 * Notices when a deploy has replaced the build a tab is running. Every deploy
 * prunes the previous build's hashed files, so a tab left open across one
 * holds code whose chunks are gone and whose fixes never arrive. The served
 * index.html names the current entry script, so comparing it with the one
 * this tab booted from tells whether a newer build is live.
 */

/** Where the current shell is read from. */
export const BUILD_INDEX_URL = '/index.html';

/** How often an open tab asks whether a newer build is live. */
export const BUILD_CHECK_INTERVAL_MS = 5 * 60_000;

/** The shortest gap between two checks, however often they are asked for. */
export const BUILD_CHECK_MIN_GAP_MS = 60_000;

/** A hashed entry script path, as Vite names it in a production build. */
const ENTRY_PATTERN = /\/assets\/index-[\w-]+\.js/;

/** The entry script path inside a page's HTML, or null when it names none. */
export const buildIdFromHtml = (html: string): string | null =>
  ENTRY_PATTERN.exec(html)?.[0] ?? null;

/**
 * The entry script this document booted from, or null outside a production
 * build, where there is nothing to compare.
 */
export const runningBuildId = (doc: Document = document): string | null => {
  const scripts = doc.querySelectorAll<HTMLScriptElement>(
    'script[type="module"][src]'
  );
  for (const script of scripts) {
    const match = ENTRY_PATTERN.exec(script.getAttribute('src') ?? '');
    if (match !== null) return match[0];
  }
  return null;
};

/**
 * Reads the served shell and reports whether it names a different build from
 * `running`. A failed or unreadable read counts as current, so a flaky
 * network never forces a reload.
 */
export const isNewerBuildLive = async (
  running: string,
  read: () => Promise<string> = async () => {
    const response = await fetch(BUILD_INDEX_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`Shell read ${String(response.status)}`);
    return response.text();
  }
): Promise<boolean> => {
  try {
    const live = buildIdFromHtml(await read());
    return live !== null && live !== running;
  } catch {
    return false;
  }
};
