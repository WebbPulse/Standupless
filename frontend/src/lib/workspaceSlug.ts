/**
 * Helpers for workspace slugs a workspace has retired. A changed slug keeps
 * answering for the workspace, so links built with it still open the right
 * page under the current slug.
 */

import type { WorkspaceRead } from '../types/Api';

/** Whether `slug` is the workspace's current slug or one it retired. */
export const answersToSlug = (
  workspace: Pick<WorkspaceRead, 'slug' | 'retired_slugs'>,
  slug: string
): boolean =>
  workspace.slug === slug || (workspace.retired_slugs ?? []).includes(slug);

/**
 * The workspace that retired `slug`, when no workspace in the list holds it
 * now, so an old link can be sent on to the current slug.
 */
export const workspaceRetiring = (
  workspaces: readonly WorkspaceRead[],
  slug: string
): WorkspaceRead | null =>
  workspaces.find((item) => (item.retired_slugs ?? []).includes(slug)) ?? null;

/**
 * The path a link with a retired slug should land on: the same path with the
 * `/w/<slug>` segment swapped for the current slug, query and hash kept.
 */
export const pathWithSlug = (
  pathname: string,
  search: string,
  hash: string,
  from: string,
  to: string
): string => {
  const prefix = `/w/${from}`;
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  return `/w/${to}${rest}${search}${hash}`;
};
