/**
 * Readable addresses for project and initiative pages, whose `:id` segment may
 * be a bare id or `<slug>-<id>` with any slug at all, stale ones included.
 */

import { useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { idFromReadable, readableId } from '../lib/readableIds';

/** The entity id the route's `:id` segment names, whatever slug comes before it. */
export const useRouteEntityId = (): string => {
  const { id } = useParams<{ id: string }>();
  return idFromReadable(id ?? '');
};

/** The index of the last path part that decodes to `segment`, or -1. */
const lastPartIndex = (parts: string[], segment: string): number => {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    try {
      if (decodeURIComponent(parts[index] ?? '') === segment) return index;
    } catch {
      continue;
    }
  }
  return -1;
};

/**
 * Once the entity's name is known, rewrites the address bar in place to
 * `<current-slug>-<id>`. The rewrite replaces the history entry and keeps the
 * query, hash and state, and the id the page reads never changes with the
 * slug, so nothing refetches.
 */
export const useReadableAddress = (
  entityId: string,
  name: string | null | undefined
): void => {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const segment = id ?? '';

  useEffect(() => {
    if (name === null || name === undefined || entityId === '') return;
    if (idFromReadable(segment) !== entityId) return;
    const wanted = readableId(entityId, name);
    if (wanted === segment) return;
    const parts = location.pathname.split('/');
    const at = lastPartIndex(parts, segment);
    if (at < 0) return;
    parts[at] = wanted;
    void navigate(
      {
        pathname: parts.join('/'),
        search: location.search,
        hash: location.hash,
      },
      { replace: true, state: location.state as unknown }
    );
  }, [
    name,
    entityId,
    segment,
    location.pathname,
    location.search,
    location.hash,
    location.state,
    navigate,
  ]);
};
