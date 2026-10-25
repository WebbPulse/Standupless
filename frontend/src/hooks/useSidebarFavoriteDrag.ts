/**
 * Tracks a sidebar row being dragged toward Favorites. A team's header or any
 * of its pages stands for that team, so dropping it on Favorites or a folder
 * stars it there. The drag is read from the document rather than from the
 * rows, so the rows keep their own drag handling and never move, and it is
 * noted a tick after the drag starts, since a browser drops a drag whose
 * source shifts while it begins.
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { FavoritePreview } from '../lib/favorites';
import type { FavoriteRef, TeamRead } from '../types/Api';

/** What a dragged sidebar row stars, with the title and preview its new favorite draws until the read answers. */
export interface SidebarFavoriteDrag {
  ref: FavoriteRef;
  title: string;
  preview: FavoritePreview;
}

const TEAM_SECTION_PREFIX = 'team-section-';
const SIDEBAR_NAV = '[data-testid="sidebar-nav"]';

/** The favorite a drag starting at `target` stands for, or null when it starts anywhere else. */
export const sidebarDragFavorite = (
  target: EventTarget | null,
  teams: readonly TeamRead[] | null
): SidebarFavoriteDrag | null => {
  if (!(target instanceof Element)) return null;
  const section = target.closest(`[data-testid^="${TEAM_SECTION_PREFIX}"]`);
  const testId = section?.getAttribute('data-testid') ?? '';
  const teamId = testId.slice(TEAM_SECTION_PREFIX.length);
  const team = teams?.find((row) => row.id === teamId);
  if (team === undefined) return null;
  return {
    ref: { kind: 'team', target_id: team.id },
    title: team.name,
    preview: { team_key_prefix: team.key_prefix },
  };
};

/**
 * The sidebar row being dragged in the same sidebar as `anchor`, or null, and
 * a way to forget it once it was dropped.
 */
export const useSidebarFavoriteDrag = (
  anchor: RefObject<HTMLElement | null>,
  teams: readonly TeamRead[] | null
): { drag: SidebarFavoriteDrag | null; clear: () => void } => {
  const [drag, setDrag] = useState<SidebarFavoriteDrag | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onStart = (event: Event): void => {
      const root = anchor.current?.closest(SIDEBAR_NAV) ?? null;
      const target = event.target;
      if (
        root === null ||
        !(target instanceof Node) ||
        !root.contains(target)
      ) {
        return;
      }
      const found = sidebarDragFavorite(target, teams);
      clearTimeout(timer);
      timer = setTimeout(() => {
        setDrag(found);
      }, 0);
    };
    const onEnd = (): void => {
      clearTimeout(timer);
      setDrag(null);
    };
    document.addEventListener('dragstart', onStart);
    document.addEventListener('dragend', onEnd);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('dragstart', onStart);
      document.removeEventListener('dragend', onEnd);
    };
  }, [anchor, teams]);

  const clear = useCallback(() => {
    setDrag(null);
  }, []);

  return { drag, clear };
};
