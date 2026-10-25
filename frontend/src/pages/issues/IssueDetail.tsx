/**
 * One issue, resolved from the `:key` in the route through the by-key read,
 * which is the address a person can type from memory. The view itself is
 * IssueView, shared with the inbox's reading pane; this page puts it in the
 * workspace shell, where the bar shows the issue's place in the list it was
 * opened from, and j, k and Escape step through that list or return to it.
 * Move to team gives the issue a new key, and an old key that still resolves
 * is replaced in the address with the current one. The page holds the threads
 * pinned to passages of the description, so the description and the timeline
 * share them. A segment naming several comma-separated keys opens the
 * one-off list of those issues instead.
 */

import React from 'react';
import { useParams } from 'react-router-dom';
import IssueView from '../../components/issues/IssueView';
import PassageThreadsProvider from '../../contexts/PassageThreadsProvider';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import IssueKeyList, { parseIssueKeys } from './IssueKeyList';

/** The full page for one issue, or the list of several named by key. */
export const IssueDetail: React.FC = () => {
  const { key } = useParams<{ key: string }>();
  const keys = parseIssueKeys(key ?? '');
  if (keys.length > 1) {
    const joined = keys.join(',');
    return <IssueKeyList key={joined} keys={keys} />;
  }
  return (
    <PassageThreadsProvider key={key}>
      <IssueView
        issueRef={
          keys.length === 1 && key?.includes(',') ? keys[0] : (key ?? '')
        }
        frame={({ title, label, titleAccessory, actions, content }) => (
          <WorkspaceShell
            flush
            title={title}
            tabTitle={label}
            titleAccessory={titleAccessory}
            actions={actions}
          >
            {content}
          </WorkspaceShell>
        )}
      />
    </PassageThreadsProvider>
  );
};

export default IssueDetail;
