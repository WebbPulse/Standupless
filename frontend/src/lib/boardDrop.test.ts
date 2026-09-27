/**
 * The board's no-op drop rule: a card hovered just above or below itself in
 * its own cell would not move, so no placeholder is drawn there.
 */

import { describe, expect, it } from 'vitest';
import { isNoOpDrop } from './boardDrop';

const source = { lane: 'all', column: 'todo', from: 2 };

describe('isNoOpDrop', () => {
  it('holds just above and just below the card itself', () => {
    expect(isNoOpDrop(source, { lane: 'all', column: 'todo', index: 2 })).toBe(
      true
    );
    expect(isNoOpDrop(source, { lane: 'all', column: 'todo', index: 3 })).toBe(
      true
    );
  });

  it('fails anywhere else in the cell', () => {
    expect(isNoOpDrop(source, { lane: 'all', column: 'todo', index: 0 })).toBe(
      false
    );
    expect(isNoOpDrop(source, { lane: 'all', column: 'todo', index: 4 })).toBe(
      false
    );
  });

  it('fails in another column or lane', () => {
    expect(isNoOpDrop(source, { lane: 'all', column: 'done', index: 2 })).toBe(
      false
    );
    expect(isNoOpDrop(source, { lane: 'high', column: 'todo', index: 2 })).toBe(
      false
    );
  });

  it('fails when the card is not in the cell', () => {
    expect(
      isNoOpDrop(
        { ...source, from: -1 },
        { lane: 'all', column: 'todo', index: 0 }
      )
    ).toBe(false);
  });
});
