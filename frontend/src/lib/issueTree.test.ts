/**
 * That a section nests sub-issues under a parent in the same section in the
 * section's own order, leaves a sub-issue whose parent is elsewhere at the
 * top level, hides a folded parent's descendants, and never loses an issue
 * caught in a parent cycle.
 */

import { describe, expect, it } from 'vitest';
import { parentRefOf, treeGuides, treeRows, type TreeIssue } from './issueTree';

/** An issue with an id and an optional parent. */
const node = (id: string, parent: string | null = null): TreeIssue => ({
  id,
  parent_id: parent,
});

/** The rows as id and depth pairs. */
const shape = (
  issues: TreeIssue[],
  nest = true,
  folded: string[] = []
): [string, number][] =>
  treeRows(issues, nest, (id) => folded.includes(id)).map((row) => [
    row.issue.id,
    row.depth,
  ]);

describe('treeRows', () => {
  it('draws sub-issues beneath their parent in section order', () => {
    const issues = [
      node('c1', 'p'),
      node('u'),
      node('p'),
      node('g', 'c1'),
      node('c2', 'p'),
    ];
    expect(shape(issues)).toEqual([
      ['u', 0],
      ['p', 0],
      ['c1', 1],
      ['g', 2],
      ['c2', 1],
    ]);
  });

  it('counts the sub-issues present and names the parent row', () => {
    const rows = treeRows([node('p'), node('c', 'p')], true, () => false);
    expect(rows.map((row) => [row.childCount, row.parentId])).toEqual([
      [1, null],
      [0, 'p'],
    ]);
  });

  it('keeps a sub-issue whose parent is not in the section at the top', () => {
    expect(shape([node('c', 'elsewhere'), node('u')])).toEqual([
      ['c', 0],
      ['u', 0],
    ]);
  });

  it('hides every descendant of a folded parent', () => {
    const issues = [node('p'), node('c', 'p'), node('g', 'c'), node('u')];
    expect(shape(issues, true, ['p'])).toEqual([
      ['p', 0],
      ['u', 0],
    ]);
  });

  it('keeps the flat order with nesting off', () => {
    const issues = [node('c', 'p'), node('p')];
    expect(shape(issues, false)).toEqual([
      ['c', 0],
      ['p', 0],
    ]);
  });

  it('draws an issue caught in a parent cycle at the top level', () => {
    expect(shape([node('a', 'b'), node('b', 'a')])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });
});

describe('treeGuides', () => {
  it('ends the guide at the last sibling and carries an ancestor past it', () => {
    const guides = treeGuides([
      { depth: 0 },
      { depth: 1 },
      { depth: 2 },
      { depth: 1 },
      { depth: 0 },
    ]);

    expect(guides.map((guide) => guide.last)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(guides[2]?.continues).toEqual([true]);
    expect(guides[3]?.continues).toEqual([]);
  });
});

describe('parentRefOf', () => {
  const loaded = new Map([
    [
      'p',
      {
        id: 'p',
        key: 'ENG-1',
        title: 'Loaded',
        progress: { total: 2, completed: 1 },
      },
    ],
  ]);

  it('prefers the loaded parent row and its progress', () => {
    expect(
      parentRefOf(
        { parent_id: 'p', parent_key: 'OLD-1', parent_title: 'Old' },
        loaded
      )
    ).toEqual({
      id: 'p',
      key: 'ENG-1',
      title: 'Loaded',
      progress: { total: 2, completed: 1 },
    });
  });

  it('falls back to the key and title the list attached', () => {
    expect(
      parentRefOf({ parent_id: 'q', parent_key: 'ENG-7', parent_title: 'Far' })
    ).toEqual({ id: 'q', key: 'ENG-7', title: 'Far' });
  });

  it('names nothing for a top-level issue or an unnamed parent', () => {
    expect(parentRefOf({ parent_id: null })).toBeUndefined();
    expect(parentRefOf({ parent_id: 'q' })).toBeUndefined();
  });
});
