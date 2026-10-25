/**
 * The bulk actions that have no bulk route: moving a selection to another
 * team and subscribing the caller to it or off it. Each runs the single
 * issue route once per issue, so a bulk move leaves exactly the rows the
 * same moves made one at a time would, and raises one notice with the count.
 */

import { invalidateQueries, type QueryKey } from '@webbpulse/api-client/react';
import { moveIssue } from '../api/issues';
import { subscribe, unsubscribe } from '../api/notifications';
import type { IssueRead, TeamRead } from '../types/Api';
import { errorMessage } from './errors';
import { recordMoves } from './issueUndo';
import { activityKey, issueKey, subscribersKey } from './queryKeys';
import { showErrorToast, showToast } from './toast';

/** "ENG-1" for one issue, "3 issues" for more. */
export const issueCount = (
  issues: readonly Pick<IssueRead, 'key'>[]
): string => {
  const first = issues[0];
  return issues.length === 1 && first !== undefined
    ? first.key
    : `${String(issues.length)} issues`;
};

/**
 * The issues in the order a move runs them: those whose parent is not
 * moving with them first, then the sub-issues whose parent is, so a parent
 * takes its sub-issues along before they are reached and each of those
 * moves answers it as already there.
 */
export const moveOrder = <T extends Pick<IssueRead, 'id' | 'parent_id'>>(
  issues: readonly T[]
): T[] => {
  const ids = new Set(issues.map((issue) => issue.id));
  const riding = (issue: T): boolean =>
    issue.parent_id !== null && ids.has(issue.parent_id);
  return [
    ...issues.filter((issue) => !riding(issue)),
    ...issues.filter(riding),
  ];
};

/** Options for {@link moveIssues}. */
export interface MoveIssuesOptions {
  /** Queries that re-read once the moves land and once their undo does. */
  invalidate?: readonly QueryKey[];
}

/**
 * Moves the issues to a team one at a time, leaving out those already in it,
 * and records the moves that landed as one undo entry. A move that fails is
 * skipped and named in an error notice; the rest still go. Answers the
 * issues as the moves left them.
 */
export const moveIssues = async (
  workspaceId: string,
  issues: readonly IssueRead[],
  target: Pick<TeamRead, 'id' | 'name'>,
  options: MoveIssuesOptions = {}
): Promise<IssueRead[]> => {
  const moving = moveOrder(
    issues.filter((issue) => issue.team_id !== target.id)
  );
  const moved: IssueRead[] = [];
  const landed: IssueRead[] = [];
  let failure: unknown = null;
  for (const issue of moving) {
    try {
      moved.push(await moveIssue(workspaceId, issue.id, target.id));
      landed.push(issue);
    } catch (cause) {
      failure = cause;
    }
  }
  const invalidate = [
    ...(options.invalidate ?? []),
    ...moved.map((issue) => issueKey(workspaceId, issue.key)),
  ];
  invalidateQueries([
    ...invalidate,
    ...landed.flatMap((issue) => [
      issueKey(workspaceId, issue.id),
      activityKey(issue.id),
    ]),
  ]);
  if (landed.length > 0) {
    const single = landed.length === 1 ? moved[0] : undefined;
    recordMoves(
      workspaceId,
      landed,
      single === undefined
        ? `Moved ${issueCount(landed)} to ${target.name}`
        : `Moved ${issueCount(landed)} to ${target.name} as ${single.key}`,
      { invalidate }
    );
  }
  if (failure !== null) {
    const missed = moving.length - landed.length;
    showErrorToast(
      errorMessage(
        failure,
        missed === 1
          ? 'Could not move 1 issue.'
          : `Could not move ${String(missed)} issues.`
      )
    );
  }
  return moved;
};

/**
 * Subscribes the caller to the issues, or unsubscribes them, all at once,
 * with one notice naming the count. Subscribing changes nothing about an
 * issue, so like the single toggle it records no undo.
 */
export const setSubscriptions = async (
  workspaceId: string,
  issues: readonly Pick<IssueRead, 'id' | 'key'>[],
  subscribing: boolean
): Promise<void> => {
  if (issues.length === 0) return;
  const results = await Promise.allSettled(
    issues.map((issue) =>
      subscribing
        ? subscribe(workspaceId, issue.id)
        : unsubscribe(workspaceId, issue.id)
    )
  );
  const done = issues.filter(
    (_, index) => results[index]?.status === 'fulfilled'
  );
  invalidateQueries(done.map((issue) => subscribersKey(workspaceId, issue.id)));
  if (done.length > 0) {
    showToast(
      subscribing
        ? `Subscribed to ${issueCount(done)}`
        : `Unsubscribed from ${issueCount(done)}`
    );
  }
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failed !== undefined) {
    showErrorToast(
      errorMessage(failed.reason, 'Could not change your subscription.')
    );
  }
};
