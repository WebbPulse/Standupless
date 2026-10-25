/**
 * Copying an issue's ID or address, shared by the list, the issue page and
 * the command palette so the keys, the wording and the toasts agree
 * everywhere, as they do in Linear.
 *
 * Copying a git branch name also starts the issue when the person's workflow
 * preferences ask for it: a backlog or unstarted issue moves to its team's
 * first started status and, if unassigned, is assigned to them, in one write
 * the calling surface makes so its own undo notice covers it.
 */

import type { IssueRead, StatusCategory, StatusRead } from '../types/Api';
import { gitBranchName } from './gitBranch';
import { issuePath } from './paths';
import { readPreferences, type InterfacePreferences } from './preferences';
import { sortStatuses } from './propertyOptions';
import { showErrorToast, showToast } from './toast';

/** The keys that copy the issue in focus's ID. */
export const COPY_ISSUE_ID_KEYS = 'mod+.';

/** The keys that copy the issue in focus's address. */
export const COPY_ISSUE_URL_KEYS = 'mod+shift+,';

/** The keys that copy the issue in focus's git branch name. */
export const COPY_BRANCH_KEYS = 'mod+shift+.';

/** The full address of an issue in this workspace. */
export const issueUrl = (slug: string, key: string): string =>
  `${globalThis.location.origin}${issuePath(slug, key)}`;

/**
 * Copies `text` and confirms it with `done`, then runs `then`, or says the
 * clipboard refused.
 */
export const copyText = (
  text: string,
  done: string,
  then?: () => void
): void => {
  const clipboard = globalThis.navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) {
    showErrorToast('Could not copy to the clipboard.');
    return;
  }
  void clipboard
    .writeText(text)
    .then(() => {
      showToast(done);
      then?.();
    })
    .catch(() => {
      showErrorToast('Could not copy to the clipboard.');
    });
};

/** The status categories an issue may be started from by copying its branch. */
const NOT_STARTED: ReadonlySet<StatusCategory> = new Set([
  'backlog',
  'unstarted',
]);

/** The workflow preferences copying a branch reads. */
export type BranchWorkflow = Pick<
  InterfacePreferences,
  'branchCopyStarts' | 'branchCopyAssigns'
>;

/** The change copying a branch makes, which both the single issue and the list writes take. */
export interface BranchPatch {
  status_id?: string;
  assignee_id?: string;
}

/** The issue fields that decide what copying its branch changes. */
export type BranchIssue = Pick<IssueRead, 'status_id' | 'assignee_id'> &
  Partial<Pick<IssueRead, 'in_triage'>>;

/**
 * The single patch copying an issue's branch makes, or null when there is
 * nothing to change: the issue is already started, done or waiting in
 * triage, both switches are off, or neither switch has anything to do.
 * `statuses` are the issue's own team's.
 */
export const branchStartPatch = (
  issue: BranchIssue,
  statuses: readonly StatusRead[],
  currentUserId: string,
  workflow: BranchWorkflow = readPreferences()
): BranchPatch | null => {
  if (issue.in_triage === true) return null;
  const status = statuses.find((item) => item.id === issue.status_id);
  if (status === undefined || !NOT_STARTED.has(status.category)) return null;
  const patch: BranchPatch = {};
  if (workflow.branchCopyStarts) {
    const started = sortStatuses([...statuses]).find(
      (item) => item.category === 'started' && item.hidden !== true
    );
    if (started !== undefined) patch.status_id = started.id;
  }
  if (
    workflow.branchCopyAssigns &&
    currentUserId !== '' &&
    (issue.assignee_id ?? null) === null
  ) {
    patch.assignee_id = currentUserId;
  }
  return Object.keys(patch).length === 0 ? null : patch;
};

/** What copying a branch needs to start the issue, from a surface that may edit it. */
export interface BranchStart {
  issue: BranchIssue;
  /** The issue's team's statuses. */
  statuses: readonly StatusRead[];
  /** The signed in person, assigned when the issue has nobody. */
  currentUserId: string;
  /** Writes the patch through the surface's own update, which records the undo. */
  apply: (patch: BranchPatch) => void;
}

/**
 * Copies the git branch name for an issue and names it in the toast. With
 * `start`, a landed copy also applies the workflow preferences' patch, if any.
 */
export const copyBranchName = (
  key: string,
  title: string,
  start?: BranchStart
): void => {
  const branch = gitBranchName(key, title);
  copyText(branch, `Copied ${branch}`, () => {
    if (start === undefined) return;
    const patch = branchStartPatch(
      start.issue,
      start.statuses,
      start.currentUserId
    );
    if (patch !== null) start.apply(patch);
  });
};
