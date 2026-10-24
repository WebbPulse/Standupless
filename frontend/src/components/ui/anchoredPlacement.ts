/**
 * The placement every floating surface shares: a fixed position panel kept
 * beside its anchor, flipped and shifted so it stays inside the viewport. On a
 * phone width screen the panel becomes a bottom sheet instead, kept above the
 * on screen keyboard.
 */

import type React from 'react';
import { useCallback, useEffect, useLayoutEffect } from 'react';

/** The gap between the trigger and the panel, in pixels. */
const OFFSET = 4;

/** The margin kept between the panel and the viewport edge, in pixels. */
const EDGE = 8;

/** The viewport widths that show floating panels as bottom sheets. */
export const SHEET_QUERY = '(max-width: 639.98px)';

/** Whether floating panels show as bottom sheets at the current width. */
export const isSheetViewport = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia(SHEET_QUERY).matches;

/**
 * Lifts a bottom sheet above the on screen keyboard and caps its height to
 * the visible viewport, through the custom properties the sheet styles read.
 */
const placeSheet = (node: HTMLElement): void => {
  const visual = window.visualViewport;
  const visibleHeight = visual?.height ?? window.innerHeight;
  const covered = Math.max(
    0,
    window.innerHeight - visibleHeight - (visual?.offsetTop ?? 0)
  );
  node.style.setProperty('--sheet-bottom', `${String(covered)}px`);
  node.style.setProperty(
    '--sheet-max-height',
    `${String(Math.round(visibleHeight * 0.85))}px`
  );
  node.style.visibility = 'visible';
};

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
 * way. At phone widths it hands the panel to the bottom sheet styles instead.
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
    if (isSheetViewport()) {
      placeSheet(node);
      return;
    }
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
    const visual = window.visualViewport;
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    visual?.addEventListener('resize', onViewport);
    return () => {
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
      visual?.removeEventListener('resize', onViewport);
    };
  }, [open, place]);
};
