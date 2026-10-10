/**
 * An issue opened in a pane beside a list, such as the inbox's reading pane.
 * It is the same IssueView the issue page shows, under a slim bar of its own
 * that links to the full page and closes the pane, so reading an issue from
 * the inbox loses nothing the page offers.
 */

import React from 'react';
import IssueView from './IssueView';

/** Props for IssuePane. */
export interface IssuePaneProps {
  issueId: string;
  onClose: () => void;
}

/** One issue in full, inside a pane. */
export const IssuePane: React.FC<IssuePaneProps> = ({ issueId, onClose }) => (
  <IssueView
    issueRef={issueId}
    lookup="id"
    onClose={onClose}
    frame={({ title, actions, content }) => (
      <section
        aria-label="Issue"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div className="flex h-topbar shrink-0 items-center gap-2 border-b border-line px-4 text-sm">
          <div className="min-w-0 flex-1">{title}</div>
          {actions}
        </div>
        {content}
      </section>
    )}
  />
);

export default IssuePane;
