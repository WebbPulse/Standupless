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
  matchesSearch,
  orderGroups,
  parseView,
  searchGroups,
  teamKeyOf,
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
    expect(groupKey(row({ kind: 'project_update', project_id: 'p-1' }))).toBe(
      'project:p-1'
    );
  });

  it('groups a reply on an initiative update by initiative', () => {
    expect(
      groupKey(
        row({
          kind: 'project_update_comment',
          project_id: null,
          initiative_id: 'i-1',
        })
      )
    ).toBe('initiative:i-1');
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
      viewQuery({
        ...DEFAULT_VIEW,
        categories: ['due'],
        showRead: false,
        showSnoozed: true,
      })
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
      unreadFirst: false,
    });
  });

  it('reads back Show unread first', () => {
    expect(parseView(JSON.stringify({ unreadFirst: true })).unreadFirst).toBe(
      true
    );
    expect(parseView(JSON.stringify({ unreadFirst: 1 })).unreadFirst).toBe(
      false
    );
  });
});

describe('viewSlice', () => {
  it('leaves unread first out of the cache key, since it only reorders', () => {
    expect(viewSlice({ ...DEFAULT_VIEW, unreadFirst: true })).toBe(
      viewSlice(DEFAULT_VIEW)
    );
  });
});

describe('teamKeyOf', () => {
  it('reads the team key off an issue key', () => {
    expect(teamKeyOf(row({ issue_key: 'ENG-12' }))).toBe('ENG');
  });

  it('reads the whole key on a channel or standup notice', () => {
    expect(teamKeyOf(row({ kind: 'standup_digest', issue_key: 'OPS' }))).toBe(
      'OPS'
    );
    expect(teamKeyOf(row({ kind: 'channel_disabled', issue_key: 'OPS' }))).toBe(
      'OPS'
    );
  });

  it('names no team for a pull request or a job id', () => {
    expect(
      teamKeyOf(row({ kind: 'review_requested', issue_key: 'acme/api#4' }))
    ).toBe('');
  });
});

describe('matchesSearch', () => {
  const group = (over: Partial<NotificationRead> = {}): InboxGroup =>
    at(fold([row(over)], 1), 0);

  it('matches everything on an empty search', () => {
    expect(matchesSearch(group(), '')).toBe(true);
    expect(matchesSearch(group(), '   ')).toBe(true);
  });

  it('matches the issue key and title without regard to case', () => {
    expect(matchesSearch(group(), 'eng-1')).toBe(true);
    expect(matchesSearch(group(), 'CACHE')).toBe(true);
    expect(matchesSearch(group(), 'deploy')).toBe(false);
  });

  it('matches the type label, the actor and the team key', () => {
    expect(matchesSearch(group(), 'new comment')).toBe(true);
    expect(matchesSearch(group(), 'grace')).toBe(true);
    expect(matchesSearch(group({ issue_key: 'OPS-7' }), 'ops')).toBe(true);
  });

  it('matches a project or initiative name', () => {
    expect(
      matchesSearch(
        group({
          kind: 'project_update',
          project_id: 'p-1',
          project_name: 'Billing revamp',
        }),
        'billing'
      )
    ).toBe(true);
    expect(
      matchesSearch(
        group({
          kind: 'initiative_update_due',
          initiative_id: 'i-1',
          initiative_name: 'Launch',
        }),
        'launch'
      )
    ).toBe(true);
  });

  it('needs every word, each found anywhere in the group', () => {
    const folded = at(
      fold(
        [
          row({ notification_id: 'n-2', actor_name: 'Ada' }),
          row({ notification_id: 'n-1' }),
        ],
        1
      ),
      0
    );
    expect(matchesSearch(folded, 'ada grace')).toBe(true);
    expect(matchesSearch(folded, 'ada linus')).toBe(false);
  });

  it('keeps only matching groups, in order', () => {
    const groups = fold(
      [
        row({
          notification_id: 'n-3',
          issue_id: 'iss-3',
          issue_title: 'Fix login',
        }),
        row({
          notification_id: 'n-2',
          issue_id: 'iss-2',
          issue_title: 'Cache keys',
        }),
        row({ notification_id: 'n-1' }),
      ],
      3
    );
    expect(searchGroups(groups, 'cache').map((one) => one.key)).toEqual([
      'issue:iss-2',
      'issue:iss-1',
    ]);
    expect(searchGroups(groups, '')).toBe(groups);
  });
});

describe('orderGroups', () => {
  const groups = (): InboxGroup[] =>
    fold(
      [
        row({ notification_id: 'n-4', issue_id: 'iss-4', unread: false }),
        row({ notification_id: 'n-3', issue_id: 'iss-3' }),
        row({ notification_id: 'n-2', issue_id: 'iss-2', unread: false }),
        row({ notification_id: 'n-1', issue_id: 'iss-1' }),
      ],
      4
    );

  it('leaves newest first alone when the option is off', () => {
    const list = groups();
    expect(orderGroups(list, false)).toBe(list);
  });

  it('puts unread above read, each part still newest first', () => {
    expect(orderGroups(groups(), true).map((one) => one.key)).toEqual([
      'issue:iss-3',
      'issue:iss-1',
      'issue:iss-4',
      'issue:iss-2',
    ]);
  });

  it('holds a just opened row among the unread ones', () => {
    expect(
      orderGroups(groups(), true, 'issue:iss-4').map((one) => one.key)
    ).toEqual(['issue:iss-4', 'issue:iss-3', 'issue:iss-1', 'issue:iss-2']);
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
