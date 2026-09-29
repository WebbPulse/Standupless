/**
 * Folding a delta read of the issue list into the rows already held. The list
 * route answers `updated_since` with the changed rows that still match and the
 * ids that left, so a poll moves only what changed rather than re-reading
 * every page.
 */

import type { IssueListSort, OrderedIssueRead } from '../api/issues';
import { sortIssues } from './issueView';

/** What one delta read carries. */
export interface IssueDelta {
  issues: OrderedIssueRead[];
  removedIds: readonly string[];
}

/**
 * The held rows with a delta applied: removed ids dropped, changed rows
 * replaced or added, and the result in the list's order. A held list that
 * stopped at its ceiling is cut back to it, so a partial view stays partial
 * rather than growing with every poll.
 */
export const mergeIssueDelta = (
  held: readonly OrderedIssueRead[],
  delta: IssueDelta,
  ordering: IssueListSort,
  ceiling?: number
): OrderedIssueRead[] => {
  if (delta.issues.length === 0 && delta.removedIds.length === 0) {
    return [...held];
  }
  const gone = new Set(delta.removedIds);
  const changed = new Map(delta.issues.map((issue) => [issue.id, issue]));
  const kept = held
    .filter((issue) => !gone.has(issue.id) && !changed.has(issue.id))
    .concat([...changed.values()].filter((issue) => !gone.has(issue.id)));
  const ordered = sortIssues(kept, ordering);
  return ceiling === undefined ? ordered : ordered.slice(0, ceiling);
};
