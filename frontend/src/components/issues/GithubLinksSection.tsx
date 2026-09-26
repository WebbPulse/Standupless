/**
 * The GitHub section of the issue rail: the branch name to cut for it and the
 * pull requests linked to it.
 *
 * A link is made by naming the issue key in a branch, a pull request or a
 * commit, so there is nothing here to add or remove by hand and no route that
 * would. The branch name action is how a software engineer starts that link:
 * it copies a name carrying the key, and Cmd or Ctrl, Shift and Period copies
 * it from anywhere on the issue. With no key to build a branch from and no
 * links, the section renders nothing.
 */

import React, { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuGitBranch, LuGitPullRequest } from 'react-icons/lu';
import { listIssueLinks } from '../../api/integrations';
import { displayKeys, useShortcut } from '../../hooks/useShortcuts';
import { errorMessage } from '../../lib/errors';
import { gitBranchName } from '../../lib/gitBranch';
import { githubLinksKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { GithubIssueLinkRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { IconButton } from '../ui/button';
import RailSection from './RailSection';

/** The shortcut that copies the branch name. */
export const COPY_BRANCH_KEYS = 'mod+shift+.';

/** Props for GithubLinksSection: which issue's pull requests to show. */
export interface GithubLinksSectionProps {
  workspaceId: string;
  issueId: string;
  /** The issue key, such as GHS-1; with a title, enables the branch action. */
  issueKey?: string;
  title?: string;
}

/** How often the links are re-read while the issue is open. */
const POLL_MS = 30000;

/** How each pull request state reads in the interface. */
const STATE_LABELS: Record<GithubIssueLinkRead['pr_state'], string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

/** The icon colour for each pull request state. */
const STATE_COLORS: Record<GithubIssueLinkRead['pr_state'], string> = {
  open: 'text-success',
  draft: 'text-text-faint',
  merged: 'text-accent',
  closed: 'text-danger',
};

/** Offers the issue's branch name and lists the pull requests that name it. */
export const GithubLinksSection: React.FC<GithubLinksSectionProps> = ({
  workspaceId,
  issueId,
  issueKey,
  title,
}) => {
  const auth = useQueryAuth();
  const branch =
    issueKey === undefined ? null : gitBranchName(issueKey, title ?? '');

  const copyBranch = useCallback((): void => {
    if (branch === null) return;
    const clipboard = globalThis.navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      showErrorToast('Could not copy the branch name.');
      return;
    }
    void clipboard
      .writeText(branch)
      .then(() => {
        showToast(`Copied ${branch}`);
      })
      .catch(() => {
        showErrorToast('Could not copy the branch name.');
      });
  }, [branch]);

  useShortcut({
    keys: COPY_BRANCH_KEYS,
    label: 'Copy git branch name',
    scope: 'issue',
    group: 'Issue',
    enabled: branch !== null,
    handler: copyBranch,
  });

  const { data, error } = usePolledQuery(
    ({ signal }) => listIssueLinks(workspaceId, issueId, {}, signal),
    {
      intervalMs: POLL_MS,
      queryKey: githubLinksKey(workspaceId, issueId),
      auth,
    }
  );

  const links = data?.items ?? [];
  if (branch === null && links.length === 0 && error === null) {
    return null;
  }

  return (
    <RailSection
      title="GitHub"
      {...(links.length > 0 ? { count: String(links.length) } : {})}
      actions={
        branch === null ? undefined : (
          <IconButton
            label="Copy git branch name"
            size="sm"
            className="h-5 w-5 shrink-0"
            title={`${branch} (${displayKeys(COPY_BRANCH_KEYS)[0] ?? ''})`}
            onClick={copyBranch}
          >
            <LuGitBranch className="h-3.5 w-3.5" />
          </IconButton>
        )
      }
    >
      {error !== null ? (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the linked pull requests.'
          )}
        />
      ) : links.length === 0 ? (
        data === null ? null : (
          <p className="py-1 text-xs text-text-faint">
            No linked pull requests. Name {issueKey ?? 'the issue key'} in a
            branch or pull request to link one.
          </p>
        )
      ) : (
        <ul aria-label="Pull requests" className="space-y-0.5">
          {links.map((link) => (
            <li
              key={link.link_id}
              className="-mx-1 flex items-start gap-1.5 rounded-sm px-1 py-1 text-xs hover:bg-raised"
            >
              <LuGitPullRequest
                aria-hidden="true"
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${STATE_COLORS[link.pr_state]}`}
              />
              <div className="min-w-0 flex-1">
                <a
                  className="block truncate rounded-xs text-text hover:underline"
                  href={link.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  title={`${link.repository_full_name}#${String(link.pr_number)} ${link.pr_title}`}
                >
                  {link.repository_full_name}#{link.pr_number} {link.pr_title}
                </a>
                <p className="truncate text-text-faint">
                  {STATE_LABELS[link.pr_state]}, opened by {link.author_login}
                  {link.closes_issue ? ', closes this issue' : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
};

export default GithubLinksSection;
