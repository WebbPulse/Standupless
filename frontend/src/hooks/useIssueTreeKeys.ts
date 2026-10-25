/**
 * Walks an issue tree from the keyboard, as Linear does: Cmd or Ctrl+Shift+Up
 * opens the issue's parent and Cmd or Ctrl+Shift+Down opens its first
 * sub-issue in the order the sub-issues section shows. Each key is listed
 * under Navigation and in the palette, and stands down when the issue has no
 * parent or no sub-issues. Whatever the surface holds is used first; the
 * parent or the sub-issues are read only when it holds neither.
 */

import { getIssue, listChildren, type OrderedIssueRead } from '../api/issues';
import { firstSubIssue } from '../lib/subIssues';
import type { IssueRead, StatusRead } from '../types/Api';
import { useShortcut } from './useShortcuts';

/** The keys that open the parent issue. */
export const PARENT_ISSUE_KEYS = 'mod+shift+arrowup';

/** The keys that open the first sub-issue. */
export const FIRST_SUB_ISSUE_KEYS = 'mod+shift+arrowdown';

/** The issue a key opens. */
export interface IssueTreeTarget {
  id: string;
  key: string;
}

/** What {@link useIssueTreeKeys} needs. */
export interface IssueTreeKeysOptions {
  workspaceId: string;
  issue: IssueRead | null;
  statuses: StatusRead[];
  /** Issues already held that the parent may be among. */
  known?: readonly IssueRead[];
  /** The sub-issues already held, when the surface loads them. */
  subIssues?: readonly OrderedIssueRead[];
  /** Opens the target, such as by navigating or by peeking it. */
  onOpen: (target: IssueTreeTarget) => void;
}

/** How many sub-issues are read to find the first, when none are held. */
const CHILDREN_LIMIT = 100;

/** Binds the parent and first sub-issue keys for one issue. */
export const useIssueTreeKeys = ({
  workspaceId,
  issue,
  statuses,
  known = [],
  subIssues,
  onOpen,
}: IssueTreeKeysOptions): void => {
  const parentId = issue?.parent_id ?? null;
  const hasChildren =
    issue !== null &&
    ((subIssues?.length ?? 0) > 0 || issue.progress.total > 0);

  const open = (target: IssueTreeTarget | undefined): void => {
    if (target !== undefined) onOpen({ id: target.id, key: target.key });
  };

  useShortcut({
    keys: PARENT_ISSUE_KEYS,
    label: 'Open parent issue',
    scope: 'issue',
    group: 'Navigation',
    enabled: parentId !== null && workspaceId !== '',
    handler: (event) => {
      event?.preventDefault();
      if (parentId === null) return;
      const held = known.find((candidate) => candidate.id === parentId);
      if (held !== undefined) {
        open(held);
        return;
      }
      getIssue(workspaceId, parentId).then(open, () => undefined);
    },
  });

  useShortcut({
    keys: FIRST_SUB_ISSUE_KEYS,
    label: 'Open first sub-issue',
    scope: 'issue',
    group: 'Navigation',
    enabled: hasChildren && workspaceId !== '',
    handler: (event) => {
      event?.preventDefault();
      if (issue === null) return;
      if (subIssues !== undefined && subIssues.length > 0) {
        open(firstSubIssue(subIssues, statuses));
        return;
      }
      listChildren(workspaceId, issue.id, { limit: CHILDREN_LIMIT }).then(
        (page) => {
          open(firstSubIssue(page.issues, statuses));
        },
        () => undefined
      );
    },
  });
};

export default useIssueTreeKeys;
