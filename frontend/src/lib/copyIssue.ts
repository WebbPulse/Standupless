/**
 * Copying an issue's ID or address, shared by the list, the issue page and
 * the command palette so the keys, the wording and the toasts agree
 * everywhere, as they do in Linear.
 */

import { gitBranchName } from './gitBranch';
import { issuePath } from './paths';
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

/** Copies `text` and confirms it with `done`, or says the clipboard refused. */
export const copyText = (text: string, done: string): void => {
  const clipboard = globalThis.navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) {
    showErrorToast('Could not copy to the clipboard.');
    return;
  }
  void clipboard
    .writeText(text)
    .then(() => {
      showToast(done);
    })
    .catch(() => {
      showErrorToast('Could not copy to the clipboard.');
    });
};

/** Copies the git branch name for an issue and names it in the toast. */
export const copyBranchName = (key: string, title: string): void => {
  const branch = gitBranchName(key, title);
  copyText(branch, `Copied ${branch}`);
};
