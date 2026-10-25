/**
 * The print endnote builder. Covers numbering in the order threads started,
 * the quoted passage of an inline thread, replies under their root oldest
 * first, resolved threads left out, an orphaned reply standing alone, and
 * the author falling back to the email when there is no display name.
 */

import { describe, expect, it } from 'vitest';
import type { CommentRead } from '../types/Api';
import { buildEndnotes, endnoteAuthor } from './printEndnotes';

const comment = (
  id: string,
  at: string,
  overrides: Partial<CommentRead> = {}
): CommentRead => ({
  comment_id: id,
  issue_id: 'd-1',
  workspace_id: 'w-1',
  team_id: 't-1',
  body: `body ${id}`,
  parent_comment_id: null,
  author_id: 'u-1',
  author: { user_id: 'u-1', email: 'ada@example.com', display_name: 'Ada' },
  mentions: [],
  reactions: [],
  reply_count: 0,
  created_at: at,
  edited_at: null,
  ...overrides,
});

describe('buildEndnotes', () => {
  it('numbers threads oldest first', () => {
    const notes = buildEndnotes([
      comment('c-2', '2026-10-02T00:00:00Z'),
      comment('c-1', '2026-10-01T00:00:00Z'),
    ]);
    expect(notes.map((note) => [note.number, note.id])).toEqual([
      [1, 'c-1'],
      [2, 'c-2'],
    ]);
  });

  it('carries the quoted passage of an inline thread', () => {
    const [inline, page] = buildEndnotes([
      comment('c-1', '2026-10-01T00:00:00Z', {
        anchor: { quote: '  the launch plan ', prefix: 'a', suffix: 'b' },
      }),
      comment('c-2', '2026-10-02T00:00:00Z'),
    ]);
    expect(inline?.quote).toBe('the launch plan');
    expect(page?.quote).toBeNull();
  });

  it('holds replies under their root, oldest first', () => {
    const notes = buildEndnotes([
      comment('c-1', '2026-10-01T00:00:00Z'),
      comment('r-2', '2026-10-03T00:00:00Z', { parent_comment_id: 'c-1' }),
      comment('r-1', '2026-10-02T00:00:00Z', { parent_comment_id: 'c-1' }),
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.replies.map((reply) => reply.id)).toEqual(['r-1', 'r-2']);
    expect(notes[0]?.replies[0]).toEqual({
      id: 'r-1',
      author: 'Ada',
      at: '2026-10-02T00:00:00Z',
      body: 'body r-1',
    });
  });

  it('leaves resolved threads and their replies out', () => {
    const notes = buildEndnotes([
      comment('c-1', '2026-10-01T00:00:00Z', {
        resolution: { resolved_by: 'u-1', resolved_at: '2026-10-05T00:00:00Z' },
      }),
      comment('r-1', '2026-10-02T00:00:00Z', { parent_comment_id: 'c-1' }),
      comment('c-2', '2026-10-03T00:00:00Z'),
    ]);
    expect(notes.map((note) => [note.number, note.id])).toEqual([[1, 'c-2']]);
  });

  it('lets a reply whose root is not loaded stand as its own thread', () => {
    const notes = buildEndnotes([
      comment('r-1', '2026-10-02T00:00:00Z', { parent_comment_id: 'gone' }),
    ]);
    expect(notes.map((note) => note.id)).toEqual(['r-1']);
  });

  it('builds nothing from no comments', () => {
    expect(buildEndnotes([])).toEqual([]);
  });
});

describe('endnoteAuthor', () => {
  it('signs with the display name, or the email without one', () => {
    expect(endnoteAuthor(comment('c-1', '2026-10-01T00:00:00Z'))).toBe('Ada');
    expect(
      endnoteAuthor(
        comment('c-1', '2026-10-01T00:00:00Z', {
          author: {
            user_id: 'u-1',
            email: 'ada@example.com',
            display_name: ' ',
          },
        })
      )
    ).toBe('ada@example.com');
  });
});
