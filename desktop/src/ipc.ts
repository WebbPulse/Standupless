/**
 * The channels between the preload bridge and the main process, and the
 * checks every payload passes before the main process acts on it. The page is
 * remote content, so nothing it sends is trusted until it has been narrowed
 * here.
 */

/** The channel names, shared by both ends. */
export const CHANNELS = {
  badge: 'standupless:badge',
  notify: 'standupless:notify',
  theme: 'standupless:theme',
  navigate: 'standupless:navigate',
  navigateReady: 'standupless:navigate-ready',
  signInWithBrowser: 'standupless:sign-in-with-browser',
  openExternal: 'standupless:open-external',
  openInNewTab: 'standupless:open-in-new-tab',
  tabsState: 'standupless:tabs-state',
  tabCommand: 'standupless:tab-command',
} as const;

/** The longest notification title or body the shell shows. */
const MAX_TEXT = 300;

/** The most the badge shows before saturating. */
export const MAX_BADGE = 99;

/** A badge update: the count, and on Windows the overlay icon to draw. */
export interface BadgePayload {
  count: number;
  overlay: string | null;
}

/** A native notification the page asks for. */
export interface NotifyPayload {
  title: string;
  body: string;
  path: string;
}

/** The theme settings the page can ask the native chrome to follow. */
export type ThemeSource = 'system' | 'light' | 'dark';

/** Narrows a badge payload, clamping the count. */
export const parseBadge = (value: unknown): BadgePayload | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { count, overlay } = value as Partial<BadgePayload>;
  if (typeof count !== 'number' || !Number.isFinite(count)) return null;
  const clamped = Math.max(0, Math.min(Math.floor(count), MAX_BADGE + 1));
  const icon =
    typeof overlay === 'string' && overlay.startsWith('data:image/png;base64,')
      ? overlay
      : null;
  return { count: clamped, overlay: icon };
};

/** Trims a text field to the length the shell shows. */
const text = (value: unknown): string | null =>
  typeof value === 'string' ? value.slice(0, MAX_TEXT) : null;

/** Narrows a notification payload. */
export const parseNotify = (value: unknown): NotifyPayload | null => {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const title = text(raw.title);
  const body = text(raw.body);
  const path = text(raw.path);
  if (title === null || body === null || path === null) return null;
  return { title, body, path };
};

/** Narrows a theme source. */
export const parseTheme = (value: unknown): ThemeSource | null =>
  value === 'system' || value === 'light' || value === 'dark' ? value : null;

/** One tab as the tab strip draws it. */
export interface StripTab {
  id: number;
  title: string;
  loading: boolean;
}

/** Everything the tab strip draws. */
export interface StripState {
  tabs: StripTab[];
  activeId: number | null;
  /** Whether the strip leaves room for the macOS window buttons. */
  inset: boolean;
}

/** A request from the tab strip. */
export type TabCommand =
  | { type: 'activate'; id: number }
  | { type: 'close'; id: number }
  | { type: 'move'; id: number; index: number }
  | { type: 'new' };

/** Whether a value is a whole, non-negative number. */
const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Narrows a tab strip request. */
export const parseTabCommand = (value: unknown): TabCommand | null => {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === 'new') return { type: 'new' };
  if (!isIndex(raw.id)) return null;
  if (raw.type === 'activate' || raw.type === 'close') {
    return { type: raw.type, id: raw.id };
  }
  if (raw.type === 'move' && isIndex(raw.index)) {
    return { type: 'move', id: raw.id, index: raw.index };
  }
  return null;
};
