/**
 * The colour theme the person picked, kept in this browser only. "system"
 * means follow the operating system, which the stylesheet does on its own
 * whenever no data-theme attribute is set on the document.
 */

/** The three settings the toggle cycles through. */
export type Theme = 'system' | 'light' | 'dark';

/** The storage key the pre-paint script in index.html reads too. */
const STORAGE_KEY = 'standupless-theme';

/** Reads the stored preference, treating any failure as "system". */
export const readTheme = (): Theme => {
  try {
    const held = globalThis.localStorage.getItem(STORAGE_KEY);
    return held === 'light' || held === 'dark' ? held : 'system';
  } catch {
    return 'system';
  }
};

/** Applies a theme to the document and remembers it for the next load. */
export const applyTheme = (theme: Theme): void => {
  const root = globalThis.document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  try {
    if (theme === 'system') {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    } else {
      globalThis.localStorage.setItem(STORAGE_KEY, theme);
    }
  } catch {
    return;
  }
};

/** The setting after this one, in the order the toggle cycles. */
export const nextTheme = (theme: Theme): Theme =>
  theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';

/** How a setting reads on the toggle. */
export const themeLabel = (theme: Theme): string =>
  theme === 'system'
    ? 'Theme: system'
    : theme === 'light'
      ? 'Theme: light'
      : 'Theme: dark';
