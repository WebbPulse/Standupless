/**
 * Board movement: up and down stay in the column and clamp, left and right
 * skip empty columns and keep the row, and the lane edges hold the focus.
 */

import { describe, expect, it } from 'vitest';
import { boardStep, type BoardGrid } from './boardNav';

const grid: BoardGrid = [[['a1', 'a2', 'a3'], [], ['c1'], ['d1', 'd2']]];

describe('boardStep', () => {
  it('moves within the column and clamps at its ends', () => {
    expect(boardStep(grid, 'a1', 'down')).toBe('a2');
    expect(boardStep(grid, 'a3', 'down')).toBe('a3');
    expect(boardStep(grid, 'a1', 'up')).toBe('a1');
    expect(boardStep(grid, 'd2', 'up')).toBe('d1');
  });

  it('skips an empty column and clamps the row to a shorter one', () => {
    expect(boardStep(grid, 'a3', 'right')).toBe('c1');
    expect(boardStep(grid, 'c1', 'left')).toBe('a1');
  });

  it('keeps the row when the next column is tall enough', () => {
    expect(
      boardStep(
        [
          [
            ['a1', 'a2'],
            ['b1', 'b2'],
          ],
        ],
        'a2',
        'right'
      )
    ).toBe('b2');
  });

  it('holds the focus at the edges of the board', () => {
    expect(boardStep(grid, 'a2', 'left')).toBe('a2');
    expect(boardStep(grid, 'd2', 'right')).toBe('d2');
  });

  it('stays inside the lane of the focused card', () => {
    const lanes: BoardGrid = [
      [['a1'], []],
      [[], ['b1']],
    ];
    expect(boardStep(lanes, 'a1', 'right')).toBe('a1');
    expect(boardStep(lanes, 'b1', 'left')).toBe('b1');
  });

  it('enters the board when nothing is focused', () => {
    expect(boardStep(grid, null, 'down')).toBe('a1');
    expect(boardStep(grid, null, 'right')).toBe('a1');
    expect(boardStep(grid, null, 'up')).toBe('a3');
    expect(boardStep(grid, null, 'left')).toBe('d1');
    expect(boardStep(grid, 'gone', 'down')).toBe('a1');
  });

  it('answers nothing on an empty board', () => {
    expect(boardStep([[[], []]], null, 'down')).toBeUndefined();
  });
});
