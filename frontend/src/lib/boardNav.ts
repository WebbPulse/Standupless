/**
 * Keyboard movement on a board, where up and down stay inside a column and
 * left and right cross to the neighbouring column of the same swimlane.
 *
 * The board is handed in as a grid of issue ids: lanes, then the columns of
 * each lane in display order, then the cards of each column top to bottom.
 */

/** A board's cards by lane, then column, then position. */
export type BoardGrid = readonly (readonly (readonly string[])[])[];

/** A direction a board key moves the focus in. */
export type BoardDirection = 'up' | 'down' | 'left' | 'right';

/** Where one card sits in a {@link BoardGrid}. */
interface Cell {
  lane: number;
  column: number;
  index: number;
}

/** Finds the first place a card sits on the board. */
const locate = (grid: BoardGrid, id: string): Cell | undefined => {
  for (const [lane, columns] of grid.entries()) {
    for (const [column, cards] of columns.entries()) {
      const index = cards.indexOf(id);
      if (index !== -1) return { lane, column, index };
    }
  }
  return undefined;
};

/** The first column on the board holding a card, searching lane by lane. */
const firstFilled = (grid: BoardGrid): readonly string[] | undefined => {
  for (const columns of grid) {
    const found = columns.find((cards) => cards.length > 0);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The last column of the first filled lane that holds a card. */
const lastFilled = (grid: BoardGrid): readonly string[] | undefined => {
  for (const columns of grid) {
    const found = [...columns].reverse().find((cards) => cards.length > 0);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Where a key lands when no card has the focus yet. */
const entry = (
  grid: BoardGrid,
  direction: BoardDirection
): string | undefined => {
  if (direction === 'left') return lastFilled(grid)?.[0];
  const column = firstFilled(grid);
  if (direction === 'up') return column?.[column.length - 1];
  return column?.[0];
};

/**
 * The card a board key moves the focus to. Up and down clamp at the ends of
 * the column. Left and right skip empty columns to the nearest one holding a
 * card and keep the vertical position, or take its last card when it is
 * shorter. At the edge of the lane the focus stays where it is. With nothing
 * focused, or a focus the grid does not hold, the key enters the board.
 */
export const boardStep = (
  grid: BoardGrid,
  focusedId: string | null,
  direction: BoardDirection
): string | undefined => {
  const at = focusedId === null ? undefined : locate(grid, focusedId);
  if (at === undefined) return entry(grid, direction);
  const columns = grid[at.lane] ?? [];
  const cards = columns[at.column] ?? [];
  if (direction === 'up' || direction === 'down') {
    const next = at.index + (direction === 'down' ? 1 : -1);
    return cards[Math.min(cards.length - 1, Math.max(0, next))];
  }
  const by = direction === 'right' ? 1 : -1;
  for (
    let column = at.column + by;
    column >= 0 && column < columns.length;
    column += by
  ) {
    const target = columns[column] ?? [];
    if (target.length > 0) {
      return target[Math.min(at.index, target.length - 1)];
    }
  }
  return cards[at.index];
};
