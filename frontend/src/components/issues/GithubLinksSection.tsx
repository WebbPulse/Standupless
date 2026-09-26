/**
 * The GitHub section of an issue: the branch name to cut for it and the pull
 * requests linked to it.
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
import { Badge, Kbd, type BadgeTone } from '../ui/badge';
import Button from '../ui/button';

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

/** The pill tone for each pull request state. */
const STATE_TONES: Record<GithubIssueLinkRead['pr_state'], BadgeTone> = {
  open: 'success',
  draft: 'neutral',
  merged: 'accent',
  closed: 'danger',
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
    <section aria-labelledby="issue-github-title" className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 id="issue-github-title" className="flex-1 text-base font-semibold">
          GitHub
        </h2>
        {branch !== null && (
          <Button
            variant="ghost"
            size="sm"
            onClick={copyBranch}
            title={branch}
            className="gap-1.5 text-text-muted"
          >
            <LuGitBranch aria-hidden="true" className="h-3.5 w-3.5" />
            Copy git branch name
            <span aria-hidden="true" className="hidden gap-0.5 sm:inline-flex">
              {displayKeys(COPY_BRANCH_KEYS)[0]
                ?.split(' ')
                .map((cap) => (
                  <Kbd key={cap}>{cap}</Kbd>
                ))}
            </span>
          </Button>
        )}
      </div>

      {error !== null ? (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the linked pull requests.'
          )}
        />
      ) : links.length === 0 ? (
        data === null ? null : (
          <p className="text-sm text-text-muted">
            No linked pull requests. Name {issueKey ?? 'the issue key'} in a
            branch or pull request to link one.
          </p>
        )
      ) : (
        <ul className="rounded-md border border-line">
          {links.map((link) => (
            <li
              key={link.link_id}
              className="flex items-center gap-2.5 border-b border-line px-3 py-2 transition-colors duration-100 last:border-b-0 hover:bg-surface"
            >
              <LuGitPullRequest
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
              />
              <div className="min-w-0 flex-1">
                <a
                  className="block truncate rounded-xs text-sm text-text hover:underline"
                  href={link.pr_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {link.repository_full_name}#{link.pr_number} {link.pr_title}
                </a>
                <p className="text-xs text-text-muted">
                  {STATE_LABELS[link.pr_state]}, opened by {link.author_login}
                  {link.closes_issue ? ', closes this issue' : ''}
                </p>
              </div>
              <Badge tone={STATE_TONES[link.pr_state]}>
                {STATE_LABELS[link.pr_state]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default GithubLinksSection;
