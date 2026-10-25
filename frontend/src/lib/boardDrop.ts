/**
 * Where items dragged in an ordered surface would land, kept apart from the
 * board so the rules can be tested without a drag: which items a drag
 * carries, the manual positions a drop between two rows writes for all of
 * them, whether a drop would leave a single item where it sits, and the drag
 * image that shows how many ride along. Everything here works over a list of
 * ids, so the list rows can share it with the board.
 */

import { orderBetween } from '../api/issues';

/** A row in a manual order: its id and its key, null until first placed. */
export interface OrderedRow {
  id: string;
  sort_order?: string | null;
}

/** One row's new manual position. */
export interface SlotPlacement {
  id: string;
  sort_order: string;
}

/**
 * Whether a drop at `target` would leave the card where it already sits:
 * the same cell, just above or just below itself. No placeholder is drawn
 * there, since the dimmed card already marks that spot.
 */
export const isNoOpDrop = (
  source: { lane: string; column: string; from: number },
  target: { lane: string; column: string; index: number }
): boolean =>
  source.from >= 0 &&
  source.lane === target.lane &&
  source.column === target.column &&
  (target.index === source.from || target.index === source.from + 1);

/**
 * The ids a drag started on `leadId` carries. A drag on a selected item takes
 * the whole selection along, in `order`, which is the surface's display
 * order; ids the surface does not show are left out. A drag on an item
 * outside the selection takes that item alone and leaves the selection be.
 */
export const draggedIds = (
  leadId: string,
  selected: ReadonlySet<string>,
  order: readonly string[]
): string[] => {
  if (!selected.has(leadId) || selected.size < 2) return [leadId];
  const carried = order.filter((id) => selected.has(id));
  return carried.includes(leadId) ? carried : [leadId];
};

/**
 * The manual positions that place `movingIds` together at `index` of `rows`,
 * in the order the ids are given. `index` counts the rows as shown, the
 * moving ones that sit there included, the way a pointer between two rows
 * reads it. The keys run from the last placed row ahead of the slot up to the
 * next row after it, so rows never placed, which sort last, are never keyed.
 * Null when the drop would leave the rows in the order they already have, or
 * when no key fits.
 */
export const slotPlacements = (
  rows: readonly OrderedRow[],
  index: number,
  movingIds: readonly string[]
): SlotPlacement[] | null => {
  if (movingIds.length === 0) return null;
  const moving = new Set(movingIds);
  const slot = rows
    .slice(0, Math.max(index, 0))
    .filter((row) => !moving.has(row.id)).length;
  const others = rows.filter((row) => !moving.has(row.id));
  const placed = [
    ...others.slice(0, slot).map((row) => row.id),
    ...movingIds,
    ...others.slice(slot).map((row) => row.id),
  ];
  const sitsThere =
    movingIds.every((id) => rows.some((row) => row.id === id)) &&
    placed.length === rows.length &&
    placed.every((id, at) => rows[at]?.id === id);
  if (sitsThere) return null;
  const before =
    others
      .slice(0, slot)
      .map((row) => row.sort_order ?? null)
      .filter((key): key is string => key !== null)
      .pop() ?? null;
  const after = others[slot]?.sort_order ?? null;
  const run = (high: string | null): SlotPlacement[] => {
    let bound = before;
    return movingIds.map((id) => {
      bound = orderBetween(bound, high);
      return { id, sort_order: bound };
    });
  };
  try {
    return run(after);
  } catch {
    try {
      return run(null);
    } catch {
      return null;
    }
  }
};

/** How long the drag image stays in the page, long enough for the browser to snapshot it. */
const GHOST_MS = 0;

/**
 * Gives a drag of several items an image of the lead item with a count badge
 * such as "3 issues". The lead element is cloned off screen, badged, handed
 * to the browser as the drag image and removed straight after, so the page
 * never shows it. A drag of one item keeps the browser's own image, as does a
 * browser without `setDragImage`. Answers the image, or null when none was
 * set.
 */
export const setCountDragImage = (
  dataTransfer: { setDragImage?: DataTransfer['setDragImage'] } | null,
  lead: HTMLElement,
  count: number,
  badge: string,
  pointer: { x: number; y: number }
): HTMLElement | null => {
  if (count < 2 || typeof dataTransfer?.setDragImage !== 'function') {
    return null;
  }
  const box = lead.getBoundingClientRect();
  const ghost = lead.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('data-row-id');
  ghost.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-drag-ghost', '');
  ghost.style.position = 'fixed';
  ghost.style.top = '-10000px';
  ghost.style.left = '-10000px';
  ghost.style.pointerEvents = 'none';
  if (box.width > 0) ghost.style.width = `${String(box.width)}px`;
  const tag = document.createElement('span');
  tag.setAttribute('data-drag-count', '');
  tag.textContent = badge;
  tag.className =
    'absolute -top-2 -right-2 inline-flex h-5 items-center rounded-full bg-accent px-2 text-2xs font-medium text-on-accent shadow-sm tabular-nums';
  ghost.appendChild(tag);
  document.body.appendChild(ghost);
  dataTransfer.setDragImage(
    ghost,
    Math.max(pointer.x - box.left, 0),
    Math.max(pointer.y - box.top, 0)
  );
  window.setTimeout(() => {
    ghost.remove();
  }, GHOST_MS);
  return ghost;
};
