/**
 * What the branch name copies read besides the issue: the workspace's branch
 * format and the copier's handle. The workspace is read without requiring its
 * provider, so a surface rendered outside one copies the default format.
 */

import { useContext, useMemo } from 'react';
import { WorkspaceContext } from '../contexts/WorkspaceContextDefinition';
import {
  branchHandle,
  DEFAULT_BRANCH_FORMAT,
  type BranchFormat,
  type BranchNaming,
} from '../lib/gitBranch';
import type { Assignable } from '../lib/issuePeople';

/** The workspace's branch format, or the default outside a workspace. */
export const useBranchFormat = (): BranchFormat =>
  useContext(WorkspaceContext)?.workspace?.branch_format ??
  DEFAULT_BRANCH_FORMAT;

/** The format and the handle of the person among `people` whose id is `currentUserId`. */
export const useBranchNaming = (
  people: readonly Assignable[],
  currentUserId: string | null | undefined
): BranchNaming => {
  const format = useBranchFormat();
  const me = people.find((person) => person.user_id === currentUserId);
  const handle = branchHandle(me);
  return useMemo(() => ({ format, handle }), [format, handle]);
};
