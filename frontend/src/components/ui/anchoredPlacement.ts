/**
 * The placement every floating surface shares: a fixed position panel kept
 * beside its anchor, flipped and shifted so it stays inside the viewport.
 */

import type React from 'react';
import { useCallback, useEffect, useLayoutEffect } from 'react';

/** The gap between the trigger and the panel, in pixels. */
const OFFSET = 4;

/** The margin kept between the panel and the viewport edge, in pixels. */
const EDGE = 8;

/** Where the panel starts before it is measured: hidden, so it never flashes. */
export const UNPLACED: React.CSSProperties = {
  top: 0,
  left: 0,
  visibility: 'hidden',
};

/**
 * Keeps a fixed position panel beside its anchor while it is open: below the
 * anchor, or above it when there is no room below, lined up with the chosen
 * edge and shifted back inside the viewport when that edge would push it off
 * screen. It follows the anchor through scrolling and resizing. The menu and
 * the popover share it so every floating surface handles collisions the same
 * way.
 */
export const useAnchoredPlacement = (
  open: boolean,
  anchor: React.RefObject<HTMLElement | null>,
  panel: React.RefObject<HTMLElement | null>,
  align: 'start' | 'end'
): void => {
  const place = useCallback((): void => {
    const node = panel.current;
    const rect = anchor.current?.getBoundingClientRect();
    const box = node?.getBoundingClientRect();
    if (node === null || rect === undefined || box === undefined) return;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const below = rect.bottom + OFFSET;
    const fitsBelow = below + box.height <= viewportHeight - EDGE;
    const above = rect.top - OFFSET - box.height;
    const top = fitsBelow || above < EDGE ? below : above;
    const preferred = align === 'end' ? rect.right - box.width : rect.left;
    const left = Math.max(
      EDGE,
      Math.min(preferred, viewportWidth - box.width - EDGE)
    );
    node.style.top = `${String(top)}px`;
    node.style.left = `${String(left)}px`;
    node.style.visibility = 'visible';
  }, [anchor, panel, align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onViewport = (): void => {
      place();
    };
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    return () => {
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
    };
  }, [open, place]);
};
