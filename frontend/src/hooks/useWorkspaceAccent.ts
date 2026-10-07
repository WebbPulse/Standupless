/**
 * Keeps the document painted in the current workspace's accent while a
 * workspace route is open.
 *
 * A layout effect paints before the browser does, so a workspace switch never
 * shows a frame in the previous accent. While the workspace is still
 * resolving the pre-painted accent from index.html is left in place, and
 * leaving the workspace routes returns the document to the default.
 */

import { useLayoutEffect } from 'react';
import { paintAccent, rememberAccent } from '../lib/accent';
import type { WorkspaceRead } from '../types/Api';

/** Paints and caches the workspace accent, clearing it once the slug is known to resolve nowhere. */
export const useWorkspaceAccent = (
  workspace: WorkspaceRead | null,
  notFound: boolean
): void => {
  const slug = workspace?.slug ?? null;
  const accent = workspace?.accent_color ?? null;

  useLayoutEffect(() => {
    if (slug === null) {
      if (notFound) paintAccent(null);
      return;
    }
    paintAccent(accent);
    rememberAccent(slug, accent);
  }, [slug, accent, notFound]);

  useLayoutEffect(() => () => paintAccent(null), []);
};

export default useWorkspaceAccent;
