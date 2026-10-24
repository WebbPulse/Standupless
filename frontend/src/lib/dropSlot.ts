/**
 * Where a dragged row would land in a list, read from the rows' midpoints, so
 * the projects list and board place a drop the same way.
 */

/**
 * The index among a list's other rows that a pointer at `y` points to: the
 * first row whose midpoint sits below the pointer, or the end. Rows are the
 * `li[data-project-id]` elements, leaving out the one being moved.
 */
export const slotIndex = (
  list: HTMLElement,
  movingId: string,
  y: number
): number => {
  const rows = [
    ...list.querySelectorAll<HTMLElement>('li[data-project-id]'),
  ].filter((row) => row.dataset.projectId !== movingId);
  const index = rows.findIndex((row) => {
    const box = row.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return index < 0 ? rows.length : index;
};
