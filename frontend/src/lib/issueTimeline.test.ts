import { describe, expect, it } from 'vitest';
import type { ActivityRead, CommentRead } from '../types/Api';
import type { ActivityContext } from './activityDisplay';
import {
  buildTimeline,
  commentAttachmentIds,
  commentThreads,
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
