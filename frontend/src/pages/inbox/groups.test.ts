/**
 * The inbox's grouping and view helpers: which notifications share a row, how
 * a row's ids batch for one write, how a view becomes the list query, and how
 * a stored view reads back when storage holds something stale.
 */

import { describe, expect, it } from 'vitest';
import type { NotificationRead } from '../../types/Api';
import {
  DEFAULT_VIEW,
  batches,
  groupKey,
  groupNotifications,
  groupSnoozedUntil,
  parseView,
  snoozedIds,
  unreadIds,
  viewQuery,
  viewSlice,
  type InboxGroup,
} from './groups';
import { keepPinned } from './pinned';

/** One notification with only what a test cares about changed. */
const row = (over: Partial<NotificationRead> = {}): NotificationRead => ({
  notification_id: 'n-1',
  workspace_id: 'ws-1',
  kind: 'commented',
  issue_id: 'iss-1',
  issue_key: 'ENG-1',
  issue_title: 'Cache the token',
  team_id: 'team-1',
  comment_id: null,
  actor_id: 'user-2',
  actor_name: 'Grace',
  unread: true,
  created_at: '2026-09-17T00:00:00Z',
  expires_at: '2026-12-16T00:00:00Z',
  ...over,
});

/** The groups for some rows, failing the test when there are fewer than asked for. */
const fold = (rows: NotificationRead[], count: number): InboxGroup[] => {
  const groups = groupNotifications(rows);
  expect(groups).toHaveLength(count);
  return groups;
};

/** The group at an index, which a test has already checked is there. */
const at = (groups: InboxGroup[], index: number): InboxGroup => {
  const group = groups[index];
  if (group === undefined) throw new Error(`No group at ${String(index)}`);
  return group;
};

describe('groupKey', () => {
  it('groups issue notifications by issue', () => {
    expect(groupKey(row())).toBe('issue:iss-1');
  });

  it('groups project updates by project', () => {
    expect(
      groupKey(row({ kind: 'project_update', project_id: 'p-1' }))
    ).toBe('project:p-1');
  });

  it('keeps a review request on its own row', () => {
    expect(groupKey(row({ kind: 'review_requested' }))).toBe('n:n-1');
  });
});

describe('groupNotifications', () => {
  it('folds one issue into one row placed at its newest notification', () => {
    const groups = fold(
      [
        row({ notification_id: 'n-3', unread: false }),
        row({ notification_id: 'n-2', issue_id: 'iss-2' }),
        row({ notification_id: 'n-1' }),
      ],
      2
    );
    const first = at(groups, 0);

    expect(groups.map((group) => group.key)).toEqual([
      'issue:iss-1',
      'issue:iss-2',
    ]);
    expect(first.latest.notification_id).toBe('n-3');
    expect(first.rows).toHaveLength(2);
    expect(first.unread).toBe(true);
    expect(unreadIds(first)).toEqual(['n-1']);
  });

  it('calls a group snoozed only when every notification in it is', () => {
    const mixed = at(
      fold(
        [
          row({
            notification_id: 'n-2',
            snoozed_until: '2026-12-01T17:00:00Z',
          }),
          row(),
        ],
        1
      ),
      0
    );
    const asleep = at(
      fold([row({ snoozed_until: '2026-12-01T17:00:00Z' })], 1),
      0
    );

    expect(groupSnoozedUntil(mixed)).toBeNull();
    expect(snoozedIds(mixed)).toEqual(['n-2']);
    expect(groupSnoozedUntil(asleep)).toBe('2026-12-01T17:00:00Z');
  });
});

describe('batches', () => {
  it('splits ids into writes of the given size', () => {
    expect(batches(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(batches([])).toEqual([]);
  });
});

describe('viewQuery', () => {
  it('sends nothing for the default view', () => {
    expect(viewQuery(DEFAULT_VIEW)).toEqual({});
  });

  it('sends the kinds of every chosen type, unread and snoozed', () => {
    expect(
      viewQuery({ categories: ['due'], showRead: false, showSnoozed: true })
    ).toEqual({
      unread: true,
      include_snoozed: true,
      kind: ['due_soon', 'overdue'],
    });
  });

  it('keys the cache apart for different views', () => {
    expect(viewSlice(DEFAULT_VIEW)).not.toBe(
      viewSlice({ ...DEFAULT_VIEW, categories: ['sla'] })
    );
  });
});

describe('parseView', () => {
  it('falls back to the default for nothing or for junk', () => {
    expect(parseView(null)).toEqual(DEFAULT_VIEW);
    expect(parseView('not json')).toEqual(DEFAULT_VIEW);
    expect(parseView('7')).toEqual(DEFAULT_VIEW);
  });

  it('drops categories this build does not know', () => {
    expect(
      parseView(
        JSON.stringify({
          categories: ['mentions', 'gone'],
          showRead: false,
          showSnoozed: 'yes',
        })
      )
    ).toEqual({
      categories: ['mentions'],
      showRead: false,
      showSnoozed: false,
    });
  });
});

describe('keepPinned', () => {
  it('puts the open group back where it sat once a refetch drops it', () => {
    const groups = fold(
      [row(), row({ notification_id: 'n-2', issue_id: 'iss-2' })],
      2
    );
    const open = at(groups, 0);
    const other = at(groups, 1);

    const kept = keepPinned([other], { group: open, index: 0 }, 'n-1');

    expect(kept.map((group) => group.key)).toEqual([
      'issue:iss-1',
      'issue:iss-2',
    ]);
    expect(keepPinned([other], { group: open, index: 0 }, 'n-2')).toEqual([
      other,
    ]);
  });
});
