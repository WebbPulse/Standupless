/**
 * The tab rules, kept free of Electron so every one is a pure function: the
 * label a tab shows, the page a new tab opens on, whether two URLs are the
 * same tab, the saved tab list and the keyboard shortcuts that drive tabs.
 */

import type { Environment } from './environment';
import { isAppUrl, parseUrl } from './navigation';

/** The most tabs a relaunch restores. */
export const MAX_RESTORED_TABS = 50;

/** The longest label a tab shows. */
const MAX_LABEL = 200;

/** The document titles that say nothing about the page, so the path names it. */
const GENERIC_TITLES: ReadonlySet<string> = new Set([
  '',
  'Standupless',
  'Standupless Staging',
]);

/** The label each workspace page under `/w/<slug>/` takes from its first segment. */
const WORKSPACE_PAGES: Readonly<Record<string, string>> = {
  inbox: 'Inbox',
  issues: 'My issues',
  reviews: 'Reviews',
  pulse: 'Pulse',
  roadmap: 'Roadmap',
  projects: 'Projects',
  initiatives: 'Initiatives',
  customers: 'Customers',
  documents: 'Document',
  views: 'Views',
  search: 'Search',
  settings: 'Settings',
};

/** The label each team page under `/w/<slug>/team/<key>/` takes. */
const TEAM_PAGES: Readonly<Record<string, string>> = {
  board: 'Board',
  archive: 'Archive',
  triage: 'Triage',
  cycles: 'Cycles',
  releases: 'Releases',
  standup: 'Standup',
  settings: 'Settings',
};

/** The label each signed out or account page takes from its path. */
const TOP_PAGES: Readonly<Record<string, string>> = {
  '/': 'Standupless',
  '/login': 'Sign in',
  '/register': 'Sign up',
  '/forgot-password': 'Reset password',
  '/reset-password': 'Reset password',
  '/workspaces': 'Workspaces',
  '/workspaces/new': 'New workspace',
  '/security': 'Security',
  '/download': 'Download',
  '/pricing': 'Pricing',
};

/** Decodes a path segment, keeping it as it is when it does not decode. */
const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** A label for a URL from its path alone, for pages that set no title. */
export const pathLabel = (value: string): string => {
  const url = parseUrl(value);
  if (url === null) return 'Standupless';
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const top = TOP_PAGES[path];
  if (top !== undefined) return top;
  const segments = path.split('/').filter(Boolean).map(decode);
  if (segments[0] !== 'w' || segments.length < 2) return 'Standupless';
  const [, slug = '', page, id, sub] = segments;
  if (page === undefined) return slug;
  if (page === 'team' && id !== undefined) {
    const teamPage = sub === undefined ? undefined : TEAM_PAGES[sub];
    return teamPage === undefined ? id : `${id} ${teamPage}`;
  }
  if (page === 'issues' && id !== undefined) return id;
  return WORKSPACE_PAGES[page] ?? 'Standupless';
};

/** The label a tab shows: the page's own title, or one read from its path. */
export const tabLabel = (title: string, url: string): string => {
  const trimmed = title.trim();
  const label =
    GENERIC_TITLES.has(trimmed) || trimmed === url ? pathLabel(url) : trimmed;
  return label.slice(0, MAX_LABEL);
};

/**
 * The page a new tab opens on: the home of the workspace the current tab is
 * in, or the workspace picker, which forwards a person with one workspace
 * straight into it.
 */
export const newTabUrl = (current: string | null, env: Environment): string => {
  const url = current === null ? null : parseUrl(current);
  if (url !== null && url.origin === env.appOrigin) {
    const match = /^\/w\/([^/]+)/.exec(url.pathname);
    if (match?.[1] !== undefined) {
      return new URL(`/w/${match[1]}`, env.appOrigin).toString();
    }
  }
  return new URL('/workspaces', env.appOrigin).toString();
};

/** Whether two URLs show the same page, ignoring the fragment and a trailing slash. */
export const sameTabUrl = (a: string, b: string): boolean => {
  const left = parseUrl(a);
  const right = parseUrl(b);
  if (left === null || right === null) return false;
  const path = (url: URL): string => url.pathname.replace(/\/+$/, '') || '/';
  return (
    left.origin === right.origin &&
    path(left) === path(right) &&
    left.search === right.search
  );
};

/** One tab as it is saved between launches. */
export interface SavedTab {
  url: string;
  title: string;
}

/** The tab list as it is saved between launches. */
export interface SavedTabs {
  tabs: SavedTab[];
  active: number;
}

/**
 * Narrows a saved tab list read from disk, keeping only app URLs, so a
 * tampered file can never open anything else, and clamping the active index.
 * Null when nothing usable is left.
 */
export const parseSavedTabs = (
  value: unknown,
  env: Environment
): SavedTabs | null => {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { tabs?: unknown; active?: unknown };
  if (!Array.isArray(raw.tabs)) return null;
  const tabs: SavedTab[] = [];
  let active = 0;
  const wanted = typeof raw.active === 'number' ? raw.active : 0;
  raw.tabs.forEach((item: unknown, index) => {
    if (tabs.length >= MAX_RESTORED_TABS) return;
    if (typeof item !== 'object' || item === null) return;
    const { url, title } = item as { url?: unknown; title?: unknown };
    if (typeof url !== 'string' || !isAppUrl(url, env)) return;
    if (index === wanted) active = tabs.length;
    tabs.push({
      url,
      title: typeof title === 'string' ? title.slice(0, MAX_LABEL) : '',
    });
  });
  return tabs.length === 0 ? null : { tabs, active };
};

/** What a tab shortcut does. */
export type TabShortcut =
  | { type: 'new' }
  | { type: 'close' }
  | { type: 'reopen' }
  | { type: 'select'; position: number }
  | { type: 'cycle'; delta: 1 | -1 };

/** The parts of a key event the tab shortcuts read. */
export interface ShortcutInput {
  type: string;
  key: string;
  code: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  isAutoRepeat: boolean;
}

/**
 * The tab shortcut a key press is, or null. Cmd on macOS and Ctrl elsewhere
 * is the modifier: T opens, W closes, Shift+T reopens and 1 to 9 select, with
 * 9 always the last tab. Ctrl+Tab and Ctrl+Shift+Tab cycle on every platform,
 * and Ctrl+PageDown and Ctrl+PageUp cycle off macOS. The page never sees
 * these keys, and none of them is an in-app shortcut, since a browser keeps
 * them all for its own tabs.
 */
export const matchTabShortcut = (
  input: ShortcutInput,
  platform: string
): TabShortcut | null => {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mac = platform === 'darwin';
  const key = input.key.toLowerCase();
  if (input.control && !input.meta && key === 'tab') {
    return { type: 'cycle', delta: input.shift ? -1 : 1 };
  }
  if (!mac && input.control && !input.meta && !input.shift) {
    if (key === 'pagedown') return { type: 'cycle', delta: 1 };
    if (key === 'pageup') return { type: 'cycle', delta: -1 };
  }
  const modifier = mac
    ? input.meta && !input.control
    : input.control && !input.meta;
  if (!modifier) return null;
  if (key === 't' || input.code === 'KeyT') {
    if (input.isAutoRepeat) return null;
    return input.shift ? { type: 'reopen' } : { type: 'new' };
  }
  if (input.shift) return null;
  if (key === 'w' || input.code === 'KeyW') {
    return input.isAutoRepeat ? null : { type: 'close' };
  }
  const digit = /^Digit([1-9])$/.exec(input.code)?.[1] ?? key;
  if (/^[1-9]$/.test(digit)) {
    return { type: 'select', position: Number(digit) };
  }
  return null;
};

/**
 * The index a select shortcut picks among `count` tabs: 1 to 8 pick that
 * tab when it exists, and 9 picks the last.
 */
export const selectIndex = (position: number, count: number): number | null => {
  if (count === 0) return null;
  if (position === 9) return count - 1;
  return position >= 1 && position <= count ? position - 1 : null;
};
