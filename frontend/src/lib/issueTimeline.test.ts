import { describe, expect, it } from 'vitest';
import type { ActivityRead, CommentRead } from '../types/Api';
import type { ActivityContext } from './activityDisplay';
import {
  anchoredThreads,
  buildTimeline,
  commentAttachmentIds,
  commentThreads,
  foldLongRuns,
  type TimelineItem,
} from './issueTimeline';

const context: ActivityContext = {
  statuses: [
    { id: 'st-todo', name: 'Todo', category: 'unstarted' },
    { id: 'st-doing', name: 'In Progress', category: 'started' },
    { id: 'st-done', name: 'Done', category: 'completed' },
  ],
  people: [],
  labels: [],
  issues: [],
  projects: [],
  cycles: [],
};

const activity = (
  id: string,
  at: string,
  overrides: Partial<ActivityRead> = {}
): ActivityRead => ({
  activity_id: id,
  issue_id: 'i-1',
  actor_id: 'u-1',
  actor_kind: 'user',
  kind: 'field_changed',
  field: 'status_id',
  from: 'st-todo',
  to: 'st-doing',
  created_at: at,
  ...overrides,
});

const commit = (id: string, at: string, sha: string): ActivityRead =>
  activity(id, at, {
    actor_kind: 'github',
    actor_id: 'gh',
    field: 'github_commit',
    from: null,
    to: { repository: 'acme/app', sha, url: '', message: '' },
  });

const comment = (
  id: string,
  at: string,
  overrides: Partial<CommentRead> = {}
): CommentRead => ({
  comment_id: id,
  issue_id: 'i-1',
  workspace_id: 'w-1',
  team_id: 't-1',
  body: id,
  parent_comment_id: null,
  author_id: 'u-1',
  author: { user_id: 'u-1', email: 'a@b.c', display_name: 'A' },
  mentions: [],
  reactions: [],
  reply_count: 0,
  created_at: at,
  edited_at: null,
  ...overrides,
});

describe('buildTimeline', () => {
  it('puts status changes and comments in one list, oldest at the top', () => {
    const items = buildTimeline(
      [
        activity('a-3', '2026-09-20T12:00:00Z', {
          from: 'st-doing',
          to: 'st-done',
        }),
        activity('a-1', '2026-09-20T09:00:00Z', {
          kind: 'created',
          field: null,
        }),
        activity('a-2', '2026-09-20T10:00:00Z'),
      ],
      [
        comment('c-2', '2026-09-20T13:00:00Z'),
        comment('c-1', '2026-09-20T11:00:00Z'),
      ],
      context
    );
    expect(items.map((item) => item.id)).toEqual([
      'a-1',
      'a-2',
      'c-1',
      'a-3',
      'c-2',
    ]);
    const last = items[items.length - 1];
    expect(last?.type).toBe('thread');
    const move = items[1];
    expect(move?.type === 'event' ? move.description.text : null).toBe(
      'changed the status from Todo to In Progress'
    );
  });

  it('breaks a tie on the same second by id so rows never swap', () => {
    const items = buildTimeline(
      [activity('a-2', '2026-09-20T10:00:00Z')],
      [comment('a-1', '2026-09-20T10:00:00Z')],
      context
    );
    expect(items.map((item) => item.id)).toEqual(['a-1', 'a-2']);
  });

  it('collapses a run of commits by the same actor', () => {
    const items = buildTimeline(
      [
        commit('a-1', '2026-09-20T10:00:00Z', 'aaa'),
        commit('a-2', '2026-09-20T10:00:01Z', 'bbb'),
        commit('a-3', '2026-09-20T10:00:02Z', 'ccc'),
      ],
      [],
      context
    );
    expect(items).toHaveLength(1);
    const group = items[0];
    expect(group?.type).toBe('group');
    expect(group?.type === 'group' ? group.events.length : 0).toBe(3);
  });

  it('does not collapse a run across two clients', () => {
    const items = buildTimeline(
      [
        { ...commit('a-1', '2026-09-20T10:00:00Z', 'aaa'), source: 'api' },
        { ...commit('a-2', '2026-09-20T10:00:01Z', 'bbb'), source: 'mcp' },
      ],
      [],
      context
    );
    expect(items.map((item) => item.type)).toEqual(['event', 'event']);
  });

  it('does not collapse across a comment', () => {
    const items = buildTimeline(
      [
        commit('a-1', '2026-09-20T10:00:00Z', 'aaa'),
        commit('a-3', '2026-09-20T12:00:00Z', 'ccc'),
      ],
      [comment('c-1', '2026-09-20T11:00:00Z')],
      context
    );
    expect(items.map((item) => item.type)).toEqual([
      'event',
      'thread',
      'event',
    ]);
  });

  it('leaves a single commit as its own row', () => {
    const items = buildTimeline(
      [commit('a-1', '2026-09-20T10:00:00Z', 'aaa')],
      [],
      context
    );
    expect(items[0]?.type).toBe('event');
  });
});

describe('rapid repeated changes', () => {
  const review = {
    id: 'st-review',
    name: 'In Review',
    category: 'started' as const,
  };
  const withReview: ActivityContext = {
    ...context,
    statuses: [...context.statuses, review],
  };

  it('reads as one change from the first value to the last', () => {
    const items = buildTimeline(
      [
        activity('a-1', '2026-09-20T10:00:00Z'),
        activity('a-2', '2026-09-20T10:03:00Z', {
          from: 'st-doing',
          to: 'st-review',
        }),
      ],
      [],
      withReview
    );
    expect(items).toHaveLength(1);
    const only = items[0];
    expect(only?.id).toBe('a-2');
    expect(only?.at).toBe('2026-09-20T10:03:00Z');
    expect(only?.type === 'event' ? only.description.text : null).toBe(
      'changed the status from Todo to In Review'
    );
  });

  it('keeps changes further apart than the window', () => {
    const items = buildTimeline(
      [
        activity('a-1', '2026-09-20T10:00:00Z'),
        activity('a-2', '2026-09-20T10:06:00Z', {
          from: 'st-doing',
          to: 'st-done',
        }),
      ],
      [],
      context
    );
    expect(items.map((item) => item.id)).toEqual(['a-1', 'a-2']);
  });

  it('does not merge across a comment', () => {
    const items = buildTimeline(
      [
        activity('a-1', '2026-09-20T10:00:00Z'),
        activity('a-2', '2026-09-20T10:02:00Z', {
          from: 'st-doing',
          to: 'st-done',
        }),
      ],
      [comment('c-1', '2026-09-20T10:01:00Z')],
      context
    );
    expect(items.map((item) => item.id)).toEqual(['a-1', 'c-1', 'a-2']);
  });

  it('keeps both changes when the last undoes the first', () => {
    const items = buildTimeline(
      [
        activity('a-1', '2026-09-20T10:00:00Z'),
        activity('a-2', '2026-09-20T10:01:00Z', {
          from: 'st-doing',
          to: 'st-todo',
        }),
      ],
      [],
      context
    );
    expect(items.map((item) => item.id)).toEqual(['a-1', 'a-2']);
  });

  it('does not merge changes to different properties or by different people', () => {
    const items = buildTimeline(
      [
        activity('a-1', '2026-09-20T10:00:00Z'),
        activity('a-2', '2026-09-20T10:01:00Z', {
          field: 'priority',
          from: 'low',
          to: 'high',
        }),
        activity('a-3', '2026-09-20T10:02:00Z', {
          field: 'priority',
          from: 'high',
          to: 'urgent',
          actor_id: 'u-2',
        }),
      ],
      [],
      context
    );
    expect(items.map((item) => item.id)).toEqual(['a-1', 'a-2', 'a-3']);
  });
});

describe('foldLongRuns', () => {
  const history = (count: number): TimelineItem[] =>
    buildTimeline(
      Array.from({ length: count }, (_, place) =>
        activity(`a-${String(place)}`, `2026-09-20T1${String(place)}:00:00Z`, {
          kind: 'created',
          field: null,
        })
      ),
      [],
      context
    );

  it('leaves a short stretch alone', () => {
    const rows = foldLongRuns(history(5));
    expect(rows.map((row) => row.type)).toEqual(Array(5).fill('event'));
  });

  it('folds the middle of a long stretch, keeping two rows at each end', () => {
    const rows = foldLongRuns(history(8));
    expect(rows.map((row) => row.id)).toEqual([
      'a-0',
      'a-1',
      'fold-a-0',
      'a-6',
      'a-7',
    ]);
    const fold = rows[2];
    expect(fold?.type === 'fold' ? fold.items.length : 0).toBe(4);
  });

  it('shows every row once the fold is opened', () => {
    const rows = foldLongRuns(history(8), new Set(['fold-a-0']));
    expect(rows).toHaveLength(8);
  });

  it('starts a new stretch after each comment', () => {
    const items = buildTimeline(
      [
        activity('a-1', '2026-09-20T10:00:00Z', {
          kind: 'created',
          field: null,
        }),
        activity('a-2', '2026-09-20T12:00:00Z', {
          kind: 'created',
          field: null,
        }),
      ],
      [comment('c-1', '2026-09-20T11:00:00Z')],
      context
    );
    expect(foldLongRuns(items).map((row) => row.id)).toEqual([
      'a-1',
      'c-1',
      'a-2',
    ]);
  });
});

describe('commentThreads', () => {
  it('nests replies under their root, oldest first', () => {
    const threads = commentThreads([
      comment('c-1', '2026-09-20T10:00:00Z'),
      comment('r-2', '2026-09-20T12:00:00Z', { parent_comment_id: 'c-1' }),
      comment('r-1', '2026-09-20T11:00:00Z', { parent_comment_id: 'c-1' }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.replies.map((reply) => reply.comment_id)).toEqual([
      'r-1',
      'r-2',
    ]);
  });

  it('keeps a reply whose root is not loaded', () => {
    const threads = commentThreads([
      comment('r-1', '2026-09-20T11:00:00Z', { parent_comment_id: 'gone' }),
    ]);
    expect(threads.map((thread) => thread.id)).toEqual(['r-1']);
  });
});

describe('commentAttachmentIds', () => {
  it('collects every attachment the comments show', () => {
    const ids = commentAttachmentIds([
      comment('c-1', '2026-09-20T10:00:00Z', {
        attachments: [
          {
            attachment_id: 'f-1',
            issue_id: 'i-1',
            workspace_id: 'w-1',
            team_id: 't-1',
            kind: 'file',
            title: 'shot.png',
            uploaded_by: 'u-1',
            created_at: '2026-09-20T10:00:00Z',
          },
        ],
      }),
      comment('c-2', '2026-09-20T11:00:00Z'),
    ]);
    expect([...ids]).toEqual(['f-1']);
  });
});

describe('anchoredThreads', () => {
  it('lists the open roots pinned to a passage, oldest first', () => {
    const anchor = { quote: 'the board query', prefix: 'cache ', suffix: '' };
    const threads = anchoredThreads([
      comment('c-2', '2026-09-20T11:00:00Z', { anchor }),
      comment('c-1', '2026-09-20T10:00:00Z', { anchor }),
      comment('c-3', '2026-09-20T12:00:00Z'),
      comment('c-4', '2026-09-20T13:00:00Z', {
        anchor,
        resolution: {
          resolved_by: 'u-1',
          resolved_at: '2026-09-20T14:00:00Z',
        },
      }),
      comment('c-5', '2026-09-20T15:00:00Z', {
        anchor,
        parent_comment_id: 'c-1',
      }),
    ]);
    expect(threads).toEqual([
      { commentId: 'c-1', anchor },
      { commentId: 'c-2', anchor },
    ]);
  });
});
