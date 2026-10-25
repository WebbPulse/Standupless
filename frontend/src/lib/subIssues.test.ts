/**
 * The sub-issues arrangement: reading what the viewer stored, falling back on
 * anything unreadable, the manual keys a drop writes, and which sub-issue
 * shows first.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { OrderedIssueRead } from '../api/issues';
import type { StatusRead } from '../types/Api';
import {
  DEFAULT_SUB_ISSUE_DISPLAY,
  SUB_ISSUE_DISPLAY_KEY,
  firstSubIssue,
  readSubIssueDisplay,
  subIssueDropKeys,
  writeSubIssueDisplay,
} from './subIssues';

const row = (id: string, sortOrder: string | null): OrderedIssueRead =>
  ({ id, sort_order: sortOrder }) as OrderedIssueRead;

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe('the stored arrangement', () => {
  it('reads the default when nothing is stored', () => {
    expect(readSubIssueDisplay()).toEqual(DEFAULT_SUB_ISSUE_DISPLAY);
  });

  it('reads back what was written', () => {
    writeSubIssueDisplay({ ordering: 'status_asc', showCompleted: false });
    expect(readSubIssueDisplay()).toEqual({
      ordering: 'status_asc',
      showCompleted: false,
    });
  });

  it('falls back field by field on unreadable values', () => {
    globalThis.localStorage.setItem(
      SUB_ISSUE_DISPLAY_KEY,
      JSON.stringify({ ordering: 'sideways', showCompleted: false })
    );
    expect(readSubIssueDisplay()).toEqual({
      ordering: 'manual',
      showCompleted: false,
    });
    globalThis.localStorage.setItem(SUB_ISSUE_DISPLAY_KEY, 'not json');
    expect(readSubIssueDisplay()).toEqual(DEFAULT_SUB_ISSUE_DISPLAY);
  });
});

describe('the keys a drop writes', () => {
  it('writes one key between placed neighbours', () => {
    const rows = [row('a', 'B'), row('b', 'D'), row('c', 'F')];
    const placements = subIssueDropKeys(rows, 'c', 1) ?? [];
    expect(placements).toHaveLength(1);
    const [only] = placements;
    expect(only?.id).toBe('c');
    expect((only?.sort_order ?? '') > 'B').toBe(true);
    expect((only?.sort_order ?? '') < 'D').toBe(true);
  });

  it('writes nothing when the row lands where it already is', () => {
    const rows = [row('a', 'B'), row('b', 'D')];
    expect(subIssueDropKeys(rows, 'a', 0)).toEqual([]);
  });

  it('places the unplaced rows ahead of a drop in order', () => {
    const rows = [row('a', null), row('b', null), row('c', null)];
    const placements = subIssueDropKeys(rows, 'a', 2) ?? [];
    expect(placements.map((placement) => placement.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    const keys = placements.map((placement) => placement.sort_order);
    expect([...keys].sort()).toEqual(keys);
  });

  it('is null for a row that is not in the list', () => {
    expect(subIssueDropKeys([row('a', 'B')], 'x', 0)).toBeNull();
  });
});

describe('the first sub-issue shown', () => {
  const statuses: StatusRead[] = [
    { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
    { id: 'st-9', name: 'Done', category: 'completed', position: 1 },
  ];
  const open = (id: string, sortOrder: string): OrderedIssueRead =>
    ({ ...row(id, sortOrder), status_id: 'st-1' }) as OrderedIssueRead;
  const done = (id: string, sortOrder: string): OrderedIssueRead =>
    ({ ...row(id, sortOrder), status_id: 'st-9' }) as OrderedIssueRead;

  it('takes the first row in manual order', () => {
    expect(firstSubIssue([open('b', 'D'), done('a', 'B')], statuses)?.id).toBe(
      'a'
    );
  });

  it('skips completed rows while they are hidden', () => {
    writeSubIssueDisplay({ ordering: 'manual', showCompleted: false });
    expect(firstSubIssue([open('b', 'D'), done('a', 'B')], statuses)?.id).toBe(
      'b'
    );
  });

  it('falls back on a completed row when every row is completed', () => {
    expect(
      firstSubIssue([done('a', 'B')], statuses, {
        ordering: 'manual',
        showCompleted: false,
      })?.id
    ).toBe('a');
  });

  it('finds nothing among no rows', () => {
    expect(firstSubIssue([], statuses)).toBeUndefined();
  });
});
