/**
 * The sub-initiative tree helpers. Covers that rows nest under a parent in
 * the same group and name a parent drawn elsewhere, that a collapsed parent
 * hides its whole branch, that a cycle never loops, and that the parent
 * candidates leave out the initiative, its descendants and anything too deep.
 */

import { describe, expect, it } from 'vitest';
import type { InitiativeRead } from '../types/Api';
import {
  descendantIds,
  initiativeTreeRows,
  parentCandidates,
  subtreeHeight,
} from './initiativeTree';

/** Builds an initiative under a parent, with the chain of ancestors given. */
const node = (
  id: string,
  parent: string | null = null,
  ancestors: string[] = []
): InitiativeRead =>
  ({
    initiative_id: id,
    name: id.toUpperCase(),
    parent_initiative_id: parent,
    ancestors: ancestors.map((ancestor) => ({
      initiative_id: ancestor,
      name: ancestor.toUpperCase(),
    })),
  }) as InitiativeRead;

describe('initiativeTreeRows', () => {
  const a = node('a');
  const b = node('b', 'a', ['a']);
  const c = node('c', 'b', ['a', 'b']);
  const d = node('d', 'a', ['a']);

  it('nests children under their parent, depth first', () => {
    const rows = initiativeTreeRows([a, b, c, d], [a, b, c, d], new Set());
    expect(
      rows.map((row) => [row.initiative.initiative_id, row.depth])
    ).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 1],
    ]);
    expect(rows[0]?.childCount).toBe(2);
  });

  it('names a parent drawn in another group', () => {
    const rows = initiativeTreeRows([c], [a, b, c], new Set());
    expect(rows).toEqual([
      { initiative: c, depth: 0, childCount: 0, parentName: 'B' },
    ]);
  });

  it('hides the whole branch under a collapsed parent', () => {
    const rows = initiativeTreeRows([a, b, c, d], [a, b, c, d], new Set(['a']));
    expect(rows.map((row) => row.initiative.initiative_id)).toEqual(['a']);
    expect(rows[0]?.childCount).toBe(2);
  });

  it('draws a cycle once rather than looping', () => {
    const x = node('x', 'y');
    const y = node('y', 'x');
    const rows = initiativeTreeRows([x, y], [x, y], new Set());
    expect(rows.map((row) => row.initiative.initiative_id).sort()).toEqual([
      'x',
      'y',
    ]);
  });
});

describe('parentCandidates', () => {
  it('leaves out the initiative and everything below it', () => {
    const a = node('a');
    const b = node('b', 'a', ['a']);
    const c = node('c', 'b', ['a', 'b']);
    const other = node('other');
    expect(descendantIds([a, b, c, other], 'a')).toEqual(new Set(['b', 'c']));
    expect(subtreeHeight([a, b, c, other], 'a')).toBe(3);
    expect(
      parentCandidates([a, b, c, other], a).map((row) => row.initiative_id)
    ).toEqual(['other']);
  });

  it('leaves out a parent the subtree would run past the cap under', () => {
    const chain = [
      node('l1'),
      node('l2', 'l1', ['l1']),
      node('l3', 'l2', ['l1', 'l2']),
      node('l4', 'l3', ['l1', 'l2', 'l3']),
    ];
    const root = node('root');
    const child = node('child', 'root', ['root']);
    const ids = parentCandidates([...chain, root, child], root).map(
      (row) => row.initiative_id
    );
    expect(ids).toEqual(['l1', 'l2', 'l3']);
  });
});
