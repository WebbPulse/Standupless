/**
 * Where leaving settings goes back to: the last page outside settings this tab
 * showed in the workspace, so Escape or Back to app on any settings page lands
 * where the person was before they opened settings, as Linear's does. Before
 * any such page has been shown, it is the workspace's home.
 *
 * The remembered route lives for the tab, not in storage, because a route from
 * an earlier visit is not where the person just was.
 */

import { workspacePath } from './paths';

/** The last route outside settings, with the workspace it belongs to. */
let remembered: { slug: string; to: string } | null = null;

/**
 * Whether a path is a settings page: workspace or account settings under
 * `/w/:slug/settings`, or one team's settings.
 */
export const isSettingsPath = (pathname: string): boolean =>
  /^\/w\/[^/]+\/(settings|team\/[^/]+\/settings)(\/|$)/.test(pathname);

/** Notes a route the tab showed, keeping it when it is outside settings. */
export const rememberAppRoute = (
  slug: string,
  pathname: string,
  search = '',
  hash = ''
): void => {
  if (slug === '' || isSettingsPath(pathname)) return;
  const base = workspacePath(slug);
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return;
  remembered = { slug, to: `${pathname}${search}${hash}` };
};

/** Where leaving settings goes in a workspace. */
export const settingsReturnPath = (slug: string): string =>
  remembered !== null && remembered.slug === slug
    ? remembered.to
    : workspacePath(slug);

/** Forgets the remembered route, for tests. */
export const resetSettingsReturn = (): void => {
  remembered = null;
};
