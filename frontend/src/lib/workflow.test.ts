/**
 * The workflow settings rules: which rows are inherited or overridden, how
 * statuses group by category, which neighbour a move swaps with, and how a
 * list merged across teams drops its repeats.
 */

import { describe, expect, it } from 'vitest';
import type { StatusRead } from '../types/Api';
import {
  groupByCategory,
  isInherited,
  isOverridden,
  nextPosition,
  swapNeighbour,
  uniqueById,
  visibleRows,
  workspaceName,
} from './workflow';

const status = (
  id: string,
  category: StatusRead['category'],
  position: number,
  extra: Partial<StatusRead> = {}
): StatusRead => ({ id, name: id, category, position, ...extra });

describe('inherited and overridden rows', () => {
  it('tells a workspace row from a team row', () => {
    expect(isInherited(status('a', 'started', 0))).toBe(false);
    expect(isInherited(status('a', 'started', 0, { scope: 'workspace' }))).toBe(
      true
    );
  });

  it('counts a hide or a rename as an override', () => {
    const base = status('a', 'started', 0, { scope: 'workspace' });
    expect(isOverridden(base)).toBe(false);
    expect(isOverridden({ ...base, hidden: true })).toBe(true);
    expect(isOverridden({ ...base, inherited_name: 'Doing' })).toBe(true);
    expect(workspaceName({ ...base, inherited_name: 'Doing' })).toBe('Doing');
    expect(workspaceName(base)).toBe('a');
  });

  it('leaves hidden rows out of the visible list', () => {
    const rows = [
      status('a', 'started', 0),
      status('b', 'started', 1, { hidden: true }),
    ];
    expect(visibleRows(rows).map((row) => row.id)).toEqual(['a']);
  });
});

describe('grouping and moving', () => {
  const rows = [
    status('done', 'completed', 3),
    status('todo', 'unstarted', 2),
    status('doing', 'started', 5),
    status('review', 'started', 4, { scope: 'workspace' }),
    status('qa', 'started', 6),
  ];

  it('answers every category in board order, sorted by position', () => {
    const groups = groupByCategory(rows);
    expect(groups.map((group) => group.category)).toEqual([
      'backlog',
      'unstarted',
      'started',
      'completed',
      'cancelled',
    ]);
    expect(groups[2]?.statuses.map((row) => row.id)).toEqual([
      'review',
      'doing',
      'qa',
    ]);
  });

  it('skips a row the caller may not move', () => {
    const started = groupByCategory(rows)[2]?.statuses ?? [];
    const own = (row: StatusRead) => !isInherited(row);
    const doing = started[1];
    if (doing === undefined) throw new Error('no doing row');
    expect(swapNeighbour(started, doing, -1, own)).toBeUndefined();
    expect(swapNeighbour(started, doing, 1, own)?.id).toBe('qa');
    expect(swapNeighbour(started, doing, -1)?.id).toBe('review');
  });

  it('places a new status after the last', () => {
    expect(nextPosition(rows)).toBe(7);
    expect(nextPosition([])).toBe(0);
  });
});

describe('uniqueById', () => {
  it('keeps the first of each id', () => {
    expect(
      uniqueById([
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
        { id: 'a', n: 3 },
      ])
    ).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]);
  });
});
