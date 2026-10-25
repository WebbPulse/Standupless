/** The Members list's URL state, filter, search, sort and CSV rows. */

import { describe, expect, it } from 'vitest';
import type { MemberRead } from '../types/Api';
import {
  applyDirectoryState,
  memberCsvRows,
  readDirectoryState,
  toggleSort,
  writeDirectoryState,
  type MemberDirectoryState,
} from './memberDirectory';

const row = (fields: Partial<MemberRead>): MemberRead => ({
  user_id: fields.user_id ?? 'u',
  email: 'x@example.com',
  display_name: 'x',
  role: 'member',
  joined_at: '2026-10-01T00:00:00Z',
  ...fields,
});

const ada = row({
  user_id: 'ada',
  display_name: 'ada',
  full_name: 'Ada Lovelace',
  email: 'ada@example.com',
  role: 'admin',
  joined_at: '2026-09-01T00:00:00Z',
});
const bob = row({
  user_id: 'bob',
  display_name: 'bob',
  email: 'bob@corp.test',
  role: 'guest',
  joined_at: '2026-10-05T00:00:00Z',
  status: 'suspended',
});
const cal = row({
  user_id: 'cal',
  display_name: 'cal',
  email: 'cal@example.com',
  role: 'owner',
  joined_at: '2026-08-01T00:00:00Z',
});
const inv = row({
  user_id: 'inv-1',
  display_name: 'new@example.com',
  email: 'new@example.com',
  status: 'invited',
  invite_id: 'inv-1',
});

const empty: MemberDirectoryState = {
  query: '',
  roles: [],
  statuses: [],
  sort: null,
  direction: 'asc',
};

const ids = (rows: MemberRead[]): string[] => rows.map((m) => m.user_id);

describe('memberDirectory', () => {
  it('groups active, invited and then suspended rows by default', () => {
    expect(ids(applyDirectoryState([bob, inv, cal, ada], empty))).toEqual([
      'ada',
      'cal',
      'inv-1',
      'bob',
    ]);
  });

  it('filters by role and status and searches name and email', () => {
    expect(
      ids(applyDirectoryState([ada, bob, cal], { ...empty, roles: ['owner'] }))
    ).toEqual(['cal']);
    expect(
      ids(
        applyDirectoryState([ada, bob, cal, inv], {
          ...empty,
          statuses: ['suspended', 'invited'],
        })
      )
    ).toEqual(['inv-1', 'bob']);
    expect(
      ids(applyDirectoryState([ada, bob, cal], { ...empty, query: 'LOVE' }))
    ).toEqual(['ada']);
    expect(
      ids(applyDirectoryState([ada, bob, cal], { ...empty, query: 'corp' }))
    ).toEqual(['bob']);
  });

  it('sorts by a chosen column and flips on a second click', () => {
    const byRole = toggleSort(empty, 'role');
    expect(ids(applyDirectoryState([bob, ada, cal], byRole))).toEqual([
      'cal',
      'ada',
      'bob',
    ]);
    const flipped = toggleSort(byRole, 'role');
    expect(flipped.direction).toBe('desc');
    expect(ids(applyDirectoryState([bob, ada, cal], flipped))).toEqual([
      'bob',
      'ada',
      'cal',
    ]);
    expect(
      ids(applyDirectoryState([bob, ada, cal], toggleSort(empty, 'joined')))
    ).toEqual(['cal', 'ada', 'bob']);
  });

  it('sorts by last active with members never seen first', () => {
    const seenEarly = { ...ada, last_active_at: '2026-10-01T00:00:00Z' };
    const seenLate = { ...cal, last_active_at: '2026-10-20T00:00:00Z' };
    const byActive = toggleSort(empty, 'active');
    expect(
      ids(applyDirectoryState([seenLate, bob, seenEarly], byActive))
    ).toEqual(['bob', 'ada', 'cal']);
    expect(
      ids(
        applyDirectoryState(
          [seenEarly, bob, seenLate],
          toggleSort(byActive, 'active')
        )
      )
    ).toEqual(['cal', 'ada', 'bob']);
    expect(
      readDirectoryState(new URLSearchParams('member_sort=active')).sort
    ).toBe('active');
  });

  it('round-trips through the URL query and keeps other keys', () => {
    const state: MemberDirectoryState = {
      query: 'ada',
      roles: ['admin', 'owner'],
      statuses: ['suspended'],
      sort: 'email',
      direction: 'desc',
    };
    const params = writeDirectoryState(new URLSearchParams('tab=x'), state);
    expect(params.get('tab')).toBe('x');
    expect(readDirectoryState(params)).toEqual({
      ...state,
      roles: ['owner', 'admin'],
    });
    expect(
      readDirectoryState(
        new URLSearchParams('member_role=root&member_sort=nope')
      )
    ).toEqual(empty);
  });

  it('builds CSV rows with the teams of each member', () => {
    expect(
      memberCsvRows([ada, bob], new Map([['ada', ['Web', 'Core']]]))
    ).toEqual([
      ['Name', 'Email', 'Role', 'Status', 'Joined', 'Teams'],
      [
        'Ada Lovelace',
        'ada@example.com',
        'Admin',
        'Active',
        '2026-09-01',
        'Core; Web',
      ],
      ['bob', 'bob@corp.test', 'Guest', 'Suspended', '2026-10-05', ''],
    ]);
  });
});
