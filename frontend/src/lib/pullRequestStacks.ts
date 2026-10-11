/**
 * Stacked pull requests as rows, and how a review decision and a check state
 * look. The server works out the stacks; this groups an issue's links so a
 * stack is one row wherever pull requests are listed beside an issue, with the
 * stack's own aggregate state, and its entries in position order.
 */

import type { IconType } from 'react-icons';
import {
  LuCircleAlert,
  LuCircleCheck,
  LuCircleDashed,
  LuSquarePen,
  LuUserRound,
  LuUserRoundCheck,
} from 'react-icons/lu';
import type {
  GithubIssueLinkRead,
  PullRequestCiState,
  PullRequestReviewState,
  PullRequestStackRead,
} from '../types/Api';

/** A pull request on its own. */
export interface SinglePullRequestRow {
  kind: 'single';
  key: string;
  link: GithubIssueLinkRead;
}

/** A stack of pull requests shown as one row. */
export interface StackedPullRequestRow {
  kind: 'stack';
  key: string;
  stack: PullRequestStackRead;
  /** The stack's entries from the bottom up. */
  entries: GithubIssueLinkRead[];
  /** The entry the collapsed row names: the lowest one still open, else the top. */
  lead: GithubIssueLinkRead;
}

/** One row of an issue's pull requests. */
export type PullRequestRow = SinglePullRequestRow | StackedPullRequestRow;

/** Whether a link's pull request still needs review and checks to land. */
const isActive = (link: GithubIssueLinkRead): boolean =>
  link.pr_state === 'open' || link.pr_state === 'draft';

/**
 * Groups an issue's links into rows, one per stack and one per unstacked pull
 * request, in the order their first link arrives.
 */
export const groupPullRequests = (
  links: readonly GithubIssueLinkRead[]
): PullRequestRow[] => {
  const rows: PullRequestRow[] = [];
  const stacks = new Map<string, StackedPullRequestRow>();
  for (const link of links) {
    const stack = link.stack ?? null;
    if (stack === null) {
      rows.push({ kind: 'single', key: link.link_id, link });
      continue;
    }
    const existing = stacks.get(stack.stack_id);
    if (existing === undefined) {
      const row: StackedPullRequestRow = {
        kind: 'stack',
        key: `stack:${stack.stack_id}`,
        stack,
        entries: [link],
        lead: link,
      };
      stacks.set(stack.stack_id, row);
      rows.push(row);
    } else {
      existing.entries.push(link);
    }
  }
  for (const row of stacks.values()) {
    row.entries.sort(
      (a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0)
    );
    row.lead =
      row.entries.find(isActive) ??
      row.entries[row.entries.length - 1] ??
      row.lead;
  }
  return rows;
};

/** How one review decision or check state renders. */
export interface StatusStyle {
  label: string;
  icon: IconType;
  colorClass: string;
}

/** Every review decision's style. A pull request no one was asked to review shows nothing. */
export const REVIEW_STATE_STYLES: Record<
  PullRequestReviewState,
  StatusStyle | null
> = {
  none: null,
  pending: {
    label: 'Review requested',
    icon: LuUserRound,
    colorClass: 'text-text-faint',
  },
  approved: {
    label: 'Approved',
    icon: LuUserRoundCheck,
    colorClass: 'text-success',
  },
  changes_requested: {
    label: 'Changes requested',
    icon: LuSquarePen,
    colorClass: 'text-danger',
  },
};

/** Every check state's style. A pull request with no checks shows nothing. */
export const CI_STATE_STYLES: Record<PullRequestCiState, StatusStyle | null> = {
  none: null,
  pending: {
    label: 'Checks running',
    icon: LuCircleDashed,
    colorClass: 'text-warning',
  },
  success: {
    label: 'Checks passed',
    icon: LuCircleCheck,
    colorClass: 'text-success',
  },
  failure: {
    label: 'Checks failed',
    icon: LuCircleAlert,
    colorClass: 'text-danger',
  },
};

/** Whether a value is a review decision this client knows. */
const isReviewState = (state: string): state is PullRequestReviewState =>
  Object.hasOwn(REVIEW_STATE_STYLES, state);

/** Whether a value is a check state this client knows. */
const isCiState = (state: string): state is PullRequestCiState =>
  Object.hasOwn(CI_STATE_STYLES, state);

/** The style for a review decision, reading one the client does not know as none. */
export const reviewStateStyle = (
  state: string | undefined
): StatusStyle | null =>
  state !== undefined && isReviewState(state)
    ? REVIEW_STATE_STYLES[state]
    : null;

/** Pull request states after which no check is still running for it. */
const FINISHED_PR_STATES: ReadonlySet<string> = new Set(['merged', 'closed']);

/**
 * The style for a check state, reading one the client does not know as none.
 *
 * A merged or closed pull request never shows checks as running: a pending
 * state there is one whose final result has not arrived, so it shows nothing.
 */
export const ciStateStyle = (
  state: string | undefined,
  prState?: string
): StatusStyle | null => {
  if (state === undefined || !isCiState(state)) {
    return null;
  }
  if (
    state === 'pending' &&
    prState !== undefined &&
    FINISHED_PR_STATES.has(prState)
  ) {
    return null;
  }
  return CI_STATE_STYLES[state];
};
