/**
 * One issue, resolved from the `:key` in the route through the by-key read,
 * which is the address a person can type from memory. The view itself is
 * IssueView, shared with the inbox's reading pane; this page puts it in the
 * workspace shell, where the bar shows the issue's place in the list it was
 * opened from, and j, k and Escape step through that list or return to it.
 * Move to team gives the issue a new key, and an old key that still resolves
 * is replaced in the address with the current one.
 */

import React from 'react';
import { useParams } from 'react-router-dom';
import IssueView from '../../components/issues/IssueView';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';

/** The full page for one issue. */
export const IssueDetail: React.FC = () => {
  const { key } = useParams<{ key: string }>();
  return (
    <IssueView
      issueRef={key ?? ''}
      frame={({ title, actions, content }) => (
        <WorkspaceShell flush title={title} actions={actions}>
          {content}
        </WorkspaceShell>
      )}
    />
  );
};

export default IssueDetail;
