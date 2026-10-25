/**
 * A page's comment threads as numbered endnotes after the body, shown only
 * when the page prints. The on-screen thread, with its composer and buttons,
 * is screen only, so the print carries the discussion as plain text instead.
 */

import React, { useMemo } from 'react';
import { buildEndnotes } from '../../lib/printEndnotes';
import type { CommentRead } from '../../types/Api';
import Markdown from '../ui/markdown';

/** A comment's date as the print states it. */
const printedDate = (at: string): string => {
  const when = new Date(at);
  return Number.isNaN(when.getTime())
    ? at
    : when.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

/** Props for PrintEndnotes. */
export interface PrintEndnotesProps {
  comments: readonly CommentRead[];
}

/** Renders the endnotes, or nothing when no thread is open. */
export const PrintEndnotes: React.FC<PrintEndnotesProps> = ({ comments }) => {
  const notes = useMemo(() => buildEndnotes(comments), [comments]);
  if (notes.length === 0) return null;
  return (
    <section
      data-testid="print-endnotes"
      aria-label="Comments"
      className="print-only space-y-4 border-t border-line pt-4 text-sm text-text"
    >
      <h2 className="text-sm font-semibold">Comments</h2>
      <ol className="space-y-4">
        {notes.map((note) => (
          <li key={note.id} className="print-endnote space-y-1.5">
            <p className="text-xs text-text-muted">
              <span className="font-semibold text-text">{`[${String(note.number)}]`}</span>{' '}
              {`${note.author}, ${printedDate(note.at)}`}
            </p>
            {note.quote !== null && (
              <blockquote className="border-l-2 border-line-strong pl-2 text-text-muted italic">
                {note.quote}
              </blockquote>
            )}
            <Markdown source={note.body} density="compact" />
            {note.replies.length > 0 && (
              <ol className="space-y-1.5 border-l border-line pl-3">
                {note.replies.map((reply) => (
                  <li key={reply.id} className="space-y-0.5">
                    <p className="text-xs text-text-muted">
                      {`${reply.author}, ${printedDate(reply.at)}`}
                    </p>
                    <Markdown source={reply.body} density="compact" />
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};

export default PrintEndnotes;
