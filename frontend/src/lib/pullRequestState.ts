/**
 * How a pull request's state looks wherever Standupless shows one: the words,
 * the icon and the theme color class. The colors follow the convention
 * software engineers already read on GitHub: open is green, a draft is gray,
 * merged is purple and closed without a merge is red.
 */

import type { IconType } from 'react-icons';
import {
  LuGitMerge,
  LuGitPullRequest,
  LuGitPullRequestClosed,
  LuGitPullRequestDraft,
} from 'react-icons/lu';
import type { GithubIssueLinkRead } from '../types/Api';

/** A pull request state as the API reports it. */
export type PullRequestState = GithubIssueLinkRead['pr_state'];

/** The label, icon and color class one pull request state renders with. */
export interface PullRequestStateStyle {
  label: string;
  icon: IconType;
  colorClass: string;
}

/** Every pull request state's style, keyed by state. */
export const PULL_REQUEST_STATE_STYLES: Record<
  PullRequestState,
  PullRequestStateStyle
> = {
  open: { label: 'Open', icon: LuGitPullRequest, colorClass: 'text-success' },
  draft: {
    label: 'Draft',
    icon: LuGitPullRequestDraft,
    colorClass: 'text-text-faint',
  },
  merged: { label: 'Merged', icon: LuGitMerge, colorClass: 'text-merged' },
  closed: {
    label: 'Closed',
    icon: LuGitPullRequestClosed,
    colorClass: 'text-danger',
  },
};

/** Whether a value is a pull request state this client knows. */
const isPullRequestState = (state: string): state is PullRequestState =>
  Object.hasOwn(PULL_REQUEST_STATE_STYLES, state);

/** The style for a state, falling back to open for one the client does not know. */
export const pullRequestStateStyle = (state: string): PullRequestStateStyle =>
  isPullRequestState(state)
    ? PULL_REQUEST_STATE_STYLES[state]
    : PULL_REQUEST_STATE_STYLES.open;

/** The pull request a chip on an issue row stands for. */
export interface PullRequestChipSubject {
  state: string;
  review_state: string;
}

/**
 * How a pull request chip on a list row or board card draws its glyph. An
 * open pull request is told apart by its review, so a row says whether it is
 * waiting on a reviewer or ready to merge without opening the issue.
 */
export const pullRequestChipStyle = (
  subject: PullRequestChipSubject
): PullRequestStateStyle => {
  const base = pullRequestStateStyle(subject.state);
  if (subject.state !== 'open') return base;
  if (subject.review_state === 'approved')
    return { label: 'Approved', icon: base.icon, colorClass: 'text-accent' };
  if (subject.review_state === 'pending')
    return {
      label: 'Review requested',
      icon: base.icon,
      colorClass: 'text-warning',
    };
  if (subject.review_state === 'changes_requested')
    return {
      label: 'Changes requested',
      icon: base.icon,
      colorClass: 'text-warning',
    };
  return base;
};
