/**
 * Opens an issue in the workspace peek pane, so a list or board can show one
 * issue beside itself without every caller building the pane content, and so
 * the close handed to the issue pane is the provider's own stable function
 * rather than a fresh closure that would re-bind its Escape listener on every
 * render.
 */

import { createElement, useCallback } from 'react';
import IssuePeek from '../components/issues/IssuePeek';
import { usePeek, type PeekContent } from './usePeek';

/** The fields of an issue the peek needs to open it. */
export interface PeekableIssue {
  id: string;
  key: string;
}

/** What {@link usePeekIssue} hands back. */
export interface PeekIssueState {
  /** Shows the issue in the pane, or closes the pane if it already shows it. */
  peekIssue: (issue: PeekableIssue) => void;
  /** The key of the issue showing, or null when no issue is peeked. */
  peekedKey: string | null;
  /** Empties the pane. */
  closePeek: () => void;
}

/** The prefix that marks pane content as an issue, as opposed to anything else. */
const ISSUE_PREFIX = 'issue:';

/**
 * The pane content for one issue, whose own tree keys swap the pane to the
 * parent or a sub-issue in place.
 */
const issueContent = (
  issue: PeekableIssue,
  openPeek: (content: PeekContent) => void,
  closePeek: () => void
): PeekContent => ({
  key: `${ISSUE_PREFIX}${issue.key}`,
  label: `Issue ${issue.key}`,
  framed: false,
  node: createElement(IssuePeek, {
    key: issue.id,
    issueId: issue.id,
    onClose: closePeek,
    onOpenIssue: (next) => {
      openPeek(issueContent(next, openPeek, closePeek));
    },
  }),
});

/** Peeks issues into the workspace pane. */
export const usePeekIssue = (): PeekIssueState => {
  const { content, openPeek, closePeek } = usePeek();
  const peekedKey =
    content?.key.startsWith(ISSUE_PREFIX) === true
      ? content.key.slice(ISSUE_PREFIX.length)
      : null;

  const peekIssue = useCallback(
    (issue: PeekableIssue) => {
      if (peekedKey === issue.key) {
        closePeek();
        return;
      }
      openPeek(issueContent(issue, openPeek, closePeek));
    },
    [peekedKey, openPeek, closePeek]
  );

  return { peekIssue, peekedKey, closePeek };
};

export default usePeekIssue;
