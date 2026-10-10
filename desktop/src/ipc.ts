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
