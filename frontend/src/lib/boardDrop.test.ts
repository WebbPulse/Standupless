/**
 * The drop rules shared by the board and the list: a card hovered just above
 * or below itself in its own cell would not move, a drag on a selected card
 * carries the selection in display order, a drop between two rows places the
 * moved rows together there, and a drag of several shows a count badge.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  draggedIds,
  isNoOpDrop,
  setCountDragImage,
  slotPlacements,
} from './boardDrop';

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

describe('draggedIds', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('carries the whole selection in display order from a selected card', () => {
    expect(draggedIds('c', new Set(['d', 'a', 'c']), order)).toEqual([
      'a',
      'c',
      'd',
    ]);
  });

  it('carries an unselected card alone', () => {
    expect(draggedIds('b', new Set(['a', 'c']), order)).toEqual(['b']);
  });

  it('carries a card alone when it is the only one selected', () => {
    expect(draggedIds('a', new Set(['a']), order)).toEqual(['a']);
  });

  it('leaves out selected ids the surface does not show', () => {
    expect(draggedIds('a', new Set(['a', 'gone', 'b']), order)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('slotPlacements', () => {
  const rows = [
    { id: 'a', sort_order: 'a0' },
    { id: 'b', sort_order: 'a1' },
    { id: 'c', sort_order: 'a2' },
    { id: 'd', sort_order: 'a3' },
  ];

  /** The ids in the order their keys sort, the rest after as given. */
  const sorted = (
    base: readonly { id: string; sort_order?: string | null }[],
    placed: readonly { id: string; sort_order: string }[]
  ): string[] => {
    const keys = new Map(base.map((row) => [row.id, row.sort_order ?? null]));
    for (const placement of placed)
      keys.set(placement.id, placement.sort_order);
    return [...keys.entries()]
      .sort(([, left], [, right]) => {
        if (left === right) return 0;
        if (left === null) return 1;
        if (right === null) return -1;
        return left < right ? -1 : 1;
      })
      .map(([id]) => id);
  };

  it('places the moved rows together at the slot in the order given', () => {
    const placed = slotPlacements(rows, 1, ['c', 'd']);
    expect(placed?.map((row) => row.id)).toEqual(['c', 'd']);
    expect(sorted(rows, placed ?? [])).toEqual(['a', 'c', 'd', 'b']);
  });

  it('places rows coming from elsewhere between two rows', () => {
    const placed = slotPlacements(rows, 2, ['x', 'y']);
    expect(sorted([...rows, { id: 'x' }, { id: 'y' }], placed ?? [])).toEqual([
      'a',
      'b',
      'x',
      'y',
      'c',
      'd',
    ]);
  });

  it('answers null when the rows already sit there', () => {
    expect(slotPlacements(rows, 1, ['b', 'c'])).toBeNull();
    expect(slotPlacements(rows, 3, ['b', 'c'])).toBeNull();
    expect(slotPlacements(rows, 0, [])).toBeNull();
  });

  it('keys above the placed rows when the rows after were never placed', () => {
    const loose = [
      { id: 'a', sort_order: 'a0' },
      { id: 'b', sort_order: null },
      { id: 'c', sort_order: null },
    ];
    const placed = slotPlacements(loose, 1, ['c']);
    expect(placed).toHaveLength(1);
    expect((placed?.[0]?.sort_order ?? '') > 'a0').toBe(true);
  });
});

describe('setCountDragImage', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /** A card element the way the board draws one. */
  const card = (): HTMLElement => {
    const element = document.createElement('li');
    element.setAttribute('data-row-id', 'iss-1');
    element.textContent = 'Cache the token';
    document.body.appendChild(element);
    return element;
  };

  it('badges a copy of the lead card with the count and drops it after', () => {
    vi.useFakeTimers();
    const setDragImage = vi.fn();
    const lead = card();

    const ghost = setCountDragImage({ setDragImage }, lead, 3, '3 issues', {
      x: 10,
      y: 10,
    });

    expect(ghost).not.toBeNull();
    expect(setDragImage).toHaveBeenCalledWith(ghost, 10, 10);
    expect(ghost?.querySelector('[data-drag-count]')?.textContent).toBe(
      '3 issues'
    );
    expect(ghost?.hasAttribute('data-row-id')).toBe(false);
    expect(document.querySelectorAll('[data-row-id="iss-1"]')).toHaveLength(1);
    vi.runAllTimers();
    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
  });

  it('keeps the browser image for one card', () => {
    const setDragImage = vi.fn();
    expect(
      setCountDragImage({ setDragImage }, card(), 1, '1 issues', { x: 0, y: 0 })
    ).toBeNull();
    expect(setDragImage).not.toHaveBeenCalled();
  });

  it('does nothing where the browser offers no drag image', () => {
    expect(
      setCountDragImage({}, card(), 2, '2 issues', { x: 0, y: 0 })
    ).toBeNull();
    expect(
      setCountDragImage(null, card(), 2, '2 issues', { x: 0, y: 0 })
    ).toBeNull();
  });
});
