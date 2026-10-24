/**
 * Copying an issue's git branch name from the issue menu or its shortcut:
 * the copied text is the branch built from the key and title, and the toast
 * names it, whether or not the issue has linked pull requests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY_BRANCH_KEYS, copyBranchName } from './copyIssue';

const showToast = vi.fn();
const showErrorToast = vi.fn();

vi.mock('./toast', () => ({
  showToast: (message: string) => {
    showToast(message);
  },
  showErrorToast: (message: string) => {
    showErrorToast(message);
  },
}));

beforeEach(() => {
  showToast.mockReset();
  showErrorToast.mockReset();
});

describe('copyBranchName', () => {
  it('binds the Linear keys', () => {
    expect(COPY_BRANCH_KEYS).toBe('mod+shift+.');
  });

  it('copies the branch built from the key and title', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    copyBranchName('STUP-1', 'Fix login');

    expect(writeText).toHaveBeenCalledWith('stup-1-fix-login');
    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Copied stup-1-fix-login');
    });
  });

  it('says so when the clipboard refuses', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });

    copyBranchName('STUP-1', 'Fix login');

    await vi.waitFor(() => {
      expect(showErrorToast).toHaveBeenCalled();
    });
    expect(showToast).not.toHaveBeenCalled();
  });
});
