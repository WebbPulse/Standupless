/**
 * Starts a comment thread pinned to a passage of the issue description, or
 * of a document when given one. It opens under the text once the Comment button over a selection is
 * pressed, shows the passage it will be pinned to, and closes when the thread
 * posts or is cancelled. It keeps no draft, since the passage is only in hand
 * while it is open.
 */

import React from 'react';
import type { Assignable } from '../../lib/issuePeople';
import type { CommentAnchor, CommentRead } from '../../types/Api';
import CommentComposer from './CommentComposer';

/** Props for PassageComposer. */
export interface PassageComposerProps {
  workspaceId: string;
  issueId: string;
  people: Assignable[];
  /** The passage the new thread is pinned to. */
  anchor: CommentAnchor;
  /** Called with the thread once it posted. */
  onPosted: (comment: CommentRead) => void;
  onCancel: () => void;
  /** The document the thread goes on, in place of the issue `issueId` names. */
  documentId?: string;
}

/** A compact composer for a new thread on one passage of the description or document. */
export const PassageComposer: React.FC<PassageComposerProps> = ({
  workspaceId,
  issueId,
  people,
  anchor,
  onPosted,
  onCancel,
  documentId,
}) => (
  <div
    role="group"
    aria-label="Comment on the selected passage"
    className="space-y-2 rounded-lg border border-line bg-raised p-2"
  >
    <p className="mx-1 line-clamp-3 border-l-2 border-warning/60 pl-2 text-xs whitespace-pre-line text-text-muted">
      {anchor.quote}
    </p>
    <CommentComposer
      workspaceId={workspaceId}
      issueId={issueId}
      people={people}
      anchor={anchor}
      {...(documentId === undefined ? {} : { documentId })}
      placeholder="Comment on this passage..."
      autoFocus
      compact
      onPosted={onPosted}
      onCancel={onCancel}
    />
  </div>
);

export default PassageComposer;
