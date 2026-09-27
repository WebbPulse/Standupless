/**
 * Opens the workspace's new issue dialog from a project or cycle page, with
 * the project or cycle preset. The dialog holds those presets with the
 * request but does not yet apply them itself, so once the issue exists this
 * files it into the project or cycle with a patch when the dialog left it
 * out, and refreshes the page's list either way.
 */

import { useCallback } from 'react';
import { invalidateQueries, type QueryKey } from '@webbpulse/api-client/react';
import { updateIssue } from '../api/issues';
import { errorMessage } from '../lib/errors';
import { showErrorToast } from '../lib/toast';
import type { IssueRead } from '../types/Api';
import { useCreateIssue } from './useCreateIssue';

/** Where the new issue goes. */
export interface PlannedIssueTarget {
  teamId?: string;
  projectId?: string;
  cycleId?: string;
}

/** What {@link useCreatePlannedIssue} hands back. */
export interface CreatePlannedIssue {
  /** Opens the dialog for the target. */
  open: (target: PlannedIssueTarget) => void;
  /** Whether the caller may create issues at all. */
  canCreate: boolean;
}

/** The patch that files an issue where the dialog was asked to put it. */
const missingFields = (
  issue: IssueRead,
  target: PlannedIssueTarget
): { project_id?: string; cycle_id?: string } => ({
  ...(target.projectId !== undefined && issue.project_id !== target.projectId
    ? { project_id: target.projectId }
    : {}),
  ...(target.cycleId !== undefined &&
  issue.cycle_id !== target.cycleId &&
  issue.team_id === target.teamId
    ? { cycle_id: target.cycleId }
    : {}),
});

/** Creates issues into the project or cycle a page shows. */
export const useCreatePlannedIssue = (
  workspaceId: string,
  refresh: QueryKey
): CreatePlannedIssue => {
  const { open: openDialog, canCreate } = useCreateIssue();
  const key = JSON.stringify(refresh);

  const open = useCallback(
    (target: PlannedIssueTarget): void => {
      openDialog({
        ...target,
        onCreated: (issue) => {
          const patch = missingFields(issue, target);
          const settle = (): void => {
            invalidateQueries(JSON.parse(key) as QueryKey);
          };
          if (Object.keys(patch).length === 0) {
            settle();
            return;
          }
          updateIssue(workspaceId, issue.id, patch).then(settle, (error) => {
            settle();
            showErrorToast(
              errorMessage(error, 'The issue was created but not filed here.')
            );
          });
        },
      });
    },
    [openDialog, workspaceId, key]
  );

  return { open, canCreate };
};

export default useCreatePlannedIssue;
