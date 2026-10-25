/**
 * Comment threads as a printed page's endnotes: each open thread, inline or
 * on the whole page, numbered in the order it was started, with the passage
 * it quotes, its author, its date and its replies. A resolved thread is done
 * with, so it is left out of the print.
 */

import type { CommentRead } from '../types/Api';

/** One reply under an endnote. */
export interface EndnoteReply {
  id: string;
  author: string;
  at: string;
  body: string;
}

/** One numbered endnote, a whole thread. */
export interface Endnote {
  number: number;
  id: string;
  /** The passage an inline thread is pinned to, or null for a page comment. */
  quote: string | null;
  author: string;
  at: string;
  body: string;
  replies: EndnoteReply[];
}

/** The name a printed comment is signed with. */
export const endnoteAuthor = (comment: CommentRead): string => {
  const name = comment.author.display_name?.trim() ?? '';
  return name === '' ? comment.author.email : name;
};

/** Oldest first, by when each comment was written, then by id. */
const byCreated = (left: CommentRead, right: CommentRead): number =>
  left.created_at.localeCompare(right.created_at) ||
  left.comment_id.localeCompare(right.comment_id);

/**
 * Builds the endnotes for a page's loaded comments. A reply whose root is not
 * among them stands as its own thread, as the on-screen thread shows it.
 */
export const buildEndnotes = (comments: readonly CommentRead[]): Endnote[] => {
  const ids = new Set(comments.map((row) => row.comment_id));
  const isRoot = (row: CommentRead): boolean =>
    row.parent_comment_id === null || !ids.has(row.parent_comment_id);
  return comments
    .filter((row) => isRoot(row) && (row.resolution ?? null) === null)
    .sort(byCreated)
    .map((root, index) => {
      const quote = root.anchor?.quote.trim() ?? '';
      return {
        number: index + 1,
        id: root.comment_id,
        quote: quote === '' ? null : quote,
        author: endnoteAuthor(root),
        at: root.created_at,
        body: root.body,
        replies: comments
          .filter((row) => row.parent_comment_id === root.comment_id)
          .sort(byCreated)
          .map((reply) => ({
            id: reply.comment_id,
            author: endnoteAuthor(reply),
            at: reply.created_at,
            body: reply.body,
          })),
      };
    });
};
