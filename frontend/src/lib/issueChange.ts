/**
 * Turns a keyboard picker's change into the single issue route's patch, for a
 * surface such as the issue page that writes one issue at a time.
 */

import type { IssueRead, IssueUpdate } from '../types/Api';
import { applyChange, type IssueChange } from './issueView';

/** The patch a picker's change becomes on the issue page's single issue route. */
export const changeToUpdate = (
  issue: IssueRead,
  change: IssueChange
): IssueUpdate => {
  const {
    add_label_ids,
    remove_label_ids,
    sort_order: _order,
    ...fields
  } = change;
  const patch: IssueUpdate = { ...fields };
  if (add_label_ids !== undefined || remove_label_ids !== undefined) {
    patch.label_ids = applyChange(issue, change).label_ids;
  }
  if (
    fields.project_id !== undefined &&
    fields.project_id !== issue.project_id &&
    fields.project_milestone_id === undefined &&
    (issue.project_milestone_id ?? null) !== null
  ) {
    patch.project_milestone_id = null;
  }
  return patch;
};
