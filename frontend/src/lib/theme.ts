/**
 * The colour theme the person picked, kept in this browser only.
 *
 * Dark is the default, because an issue tracker is a tool people keep open all
 * day and the product is designed dark first. A person can still pick light,
 * or "system" to follow the operating system, which the stylesheet does on its
 * own whenever no data-theme attribute is set on the document. Because the
 * default is no longer "follow the system", "system" is stored explicitly and
 * an empty store means dark.
 *
 * The pre-paint script in index.html applies the same rule before the bundle
 * loads, so the first frame is already in the right theme.
 */

/** The three settings a person can choose between. */
export type Theme = 'system' | 'light' | 'dark';

/** The theme a fresh browser gets. */
export const DEFAULT_THEME: Theme = 'dark';

/** The storage key the pre-paint script in index.html reads too. */
export const THEME_STORAGE_KEY = 'standupless-theme';

/** Narrows a stored value to a theme, treating anything else as the default. */
export const parseTheme = (held: string | null): Theme =>
  held === 'light' || held === 'dark' || held === 'system'
    ? held
    : DEFAULT_THEME;

/** Reads the stored preference, treating any failure as the default. */
export const readTheme = (): Theme => {
  try {
    return parseTheme(globalThis.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
};

/** Everyone who wants to hear when the theme changes, such as the toggle. */
const listeners = new Set<() => void>();

/**
 * Subscribes to theme changes made through {@link applyTheme}, so the toggle in
 * the sidebar and the command in the palette never disagree about the current
 * setting. Returns the unsubscribe function.
 */
export const subscribeTheme = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Whether the page is painted dark right now, resolving "system" against the
 * operating system, so a command can offer the opposite of what is showing.
 */
export const isDarkNow = (theme: Theme): boolean => {
  if (theme !== 'system') return theme === 'dark';
  try {
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
};

/** The browser chrome colour for each painted theme, matching `--bg`. */
const CHROME = { dark: '#141518', light: '#ffffff' } as const;

/**
 * Sets the document attribute that the stylesheet reads for one theme, and
 * the theme-color meta so the browser chrome around the page matches it.
 */
export const paintTheme = (theme: Theme): void => {
  const root = globalThis.document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  globalThis.document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', isDarkNow(theme) ? CHROME.dark : CHROME.light);
};

/**
 * Remembers a theme, ignoring a storage that refuses the write, because a
 * private window is not a reason to leave the page in the old theme.
 */
const storeTheme = (theme: Theme): void => {
  try {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    return;
  }
};

/** Applies a theme to the document, remembers it and tells the subscribers. */
export const applyTheme = (theme: Theme): void => {
  paintTheme(theme);
  storeTheme(theme);
  for (const listener of [...listeners]) listener();
};

/** The setting after this one, in the order the toggle cycles. */
export const nextTheme = (theme: Theme): Theme =>
  theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';

/** How a setting reads on the toggle. */
export const themeLabel = (theme: Theme): string =>
  theme === 'system'
    ? 'Theme: system'
    : theme === 'light'
      ? 'Theme: light'
      : 'Theme: dark';
