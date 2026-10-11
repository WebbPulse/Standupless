/**
 * The pull requests section of the issue rail: the pull requests linked to the
 * issue, each with its state, and the branch name to cut for it. The synced
 * GitHub issue lives in its own section, GithubIssueSection.
 *
 * A link is made by naming the issue key in a branch, a pull request or a
 * commit, so there is nothing here to add or remove by hand and no route that
 * would. The branch name action is how a software engineer starts that link:
 * it copies a name carrying the key, and Cmd or Ctrl, Shift and Period copies
 * it from anywhere on the issue, even while the section is hidden. With no
 * linked pull request and no error, the section renders nothing.
 *
 * Pull requests stacked on each other's branches are one row, collapsed to the
 * lowest one still open with its position in the stack and the stack's review
 * and check icons, and expand to every entry with its own. The section count
 * treats a stack as one row.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuChevronRight, LuGitBranch } from 'react-icons/lu';
import { listIssueLinks } from '../../api/integrations';
import { displayKeys, useShortcut } from '../../hooks/useShortcuts';
import { errorMessage } from '../../lib/errors';
import { gitBranchName } from '../../lib/gitBranch';
import { pullRequestStateStyle } from '../../lib/pullRequestState';
import {
  ciStateStyle,
  groupPullRequests,
  reviewStateStyle,
  type StackedPullRequestRow,
  type StatusStyle,
} from '../../lib/pullRequestStacks';
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

/** One small status icon with its meaning as its accessible name. */
const StatusIcon: React.FC<{ style: StatusStyle | null; kind: string }> = ({
  style,
  kind,
}) => {
  if (style === null) return null;
  const Icon = style.icon;
  return (
    <span
      role="img"
      aria-label={style.label}
      title={style.label}
      data-status={kind}
      className="inline-flex shrink-0"
    >
      <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${style.colorClass}`} />
    </span>
  );
};

/** The review and check icons of one pull request or one stack. */
const StatusIcons: React.FC<{
  review?: string | undefined;
  ci?: string | undefined;
  prState?: string | undefined;
}> = ({ review, ci, prState }) => (
  <span className="mt-0.5 flex shrink-0 items-center gap-1">
    <StatusIcon style={reviewStateStyle(review)} kind="review" />
    <StatusIcon style={ciStateStyle(ci, prState)} kind="ci" />
  </span>
);

/** A position badge such as 1 of 3. */
const PositionBadge: React.FC<{ position: number; size: number }> = ({
  position,
  size,
}) => (
  <span
    className="mt-px shrink-0 rounded-xs border border-line px-1 text-[10px] leading-4 text-text-muted tabular-nums"
    title={`Pull request ${String(position)} of ${String(size)} in this stack`}
  >
    {position} of {size}
  </span>
);

/** One pull request: its state, title, author, and review and check icons. */
const PullRequestEntry: React.FC<{
  link: GithubIssueLinkRead;
  badge?: React.ReactNode;
}> = ({ link, badge }) => {
  const state = pullRequestStateStyle(link.pr_state);
  const StateIcon = state.icon;
  return (
    <div className="flex items-start gap-1.5">
      <StateIcon
        aria-hidden="true"
        data-pr-state={link.pr_state}
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${state.colorClass}`}
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
          {state.label}, opened by {link.author_login}
          {link.closes_issue ? ', closes this issue' : ''}
        </p>
      </div>
      {badge}
      <StatusIcons
        review={link.review_state}
        ci={link.ci_state}
        prState={link.pr_state}
      />
    </div>
  );
};

/** A stack as one collapsible row, collapsed to its lead entry. */
const StackRow: React.FC<{ row: StackedPullRequestRow }> = ({ row }) => {
  const [open, setOpen] = useState(false);
  const { stack, lead, entries } = row;
  const size = entries.length;
  const state = pullRequestStateStyle(stack.pr_state);
  const StateIcon = state.icon;
  const repository = lead.repository_full_name;
  return (
    <li className="-mx-1 rounded-sm px-1 py-1 text-xs">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Stack of ${String(size)} pull requests in ${repository}`}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="-ml-0.5 mt-0.5 flex shrink-0 items-center rounded-xs text-text-faint hover:text-text"
        >
          <LuChevronRight
            aria-hidden="true"
            className={`h-3.5 w-3.5 transition-transform duration-100 ${open ? 'rotate-90' : ''}`}
          />
        </button>
        <StateIcon
          aria-hidden="true"
          data-pr-state={stack.pr_state}
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${state.colorClass}`}
        />
        <div className="min-w-0 flex-1">
          <a
            className="block truncate rounded-xs text-text hover:underline"
            href={lead.pr_url}
            target="_blank"
            rel="noreferrer"
            title={`${repository}#${String(lead.pr_number)} ${lead.pr_title}`}
          >
            {repository}#{lead.pr_number} {lead.pr_title}
          </a>
          <p className="truncate text-text-faint">
            Stack, {state.label.toLowerCase()}
          </p>
        </div>
        <PositionBadge position={lead.stack?.position ?? 1} size={size} />
        <StatusIcons
          review={stack.review_state}
          ci={stack.ci_state}
          prState={stack.pr_state}
        />
      </div>
      {open && (
        <ol
          aria-label={`Pull requests in the stack in ${repository}`}
          className="mt-1 ml-2 space-y-0.5 border-l border-line pl-2"
        >
          {entries.map((entry) => (
            <li
              key={entry.link_id}
              className="-mx-1 rounded-sm px-1 py-0.5 hover:bg-raised"
            >
              <PullRequestEntry
                link={entry}
                badge={
                  <PositionBadge
                    position={entry.stack?.position ?? 1}
                    size={size}
                  />
                }
              />
            </li>
          ))}
        </ol>
      )}
    </li>
  );
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
  const rows = useMemo(() => groupPullRequests(data?.items ?? []), [data]);
  if (links.length === 0 && error === null) return null;

  return (
    <RailSection
      title="Pull requests"
      {...(rows.length > 0 ? { count: String(rows.length) } : {})}
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
      ) : (
        <ul aria-label="Linked pull requests" className="space-y-0.5">
          {rows.map((row) =>
            row.kind === 'single' ? (
              <li
                key={row.key}
                className="-mx-1 rounded-sm px-1 py-1 text-xs hover:bg-raised"
              >
                <PullRequestEntry link={row.link} />
              </li>
            ) : (
              <StackRow key={row.key} row={row} />
            )
          )}
        </ul>
      )}
    </RailSection>
  );
};

export default GithubLinksSection;
