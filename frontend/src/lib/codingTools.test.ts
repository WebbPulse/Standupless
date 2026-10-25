/**
 * Handing an issue to a coding tool: the prompt comes from one fixed template
 * of the key, title, address, branch and description; a command-line tool
 * gets a quoted command that switches to the branch and is copied with a
 * toast saying so; Cursor gets a deep link that stays under the length cap;
 * and the default tool is remembered in this browser.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODING_TOOL_STORAGE_KEY,
  DEFAULT_CODING_TOOL,
  MAX_DEEP_LINK_LENGTH,
  codingCommand,
  codingDeepLink,
  codingPrompt,
  openInCodingTool,
  readDefaultCodingTool,
  setDefaultCodingTool,
  shellQuote,
  type CodingIssue,
} from './codingTools';

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

const ISSUE: CodingIssue = {
  key: 'STUP-7',
  title: "Fix the user's login",
  url: 'https://standupless.dev/acme/issue/STUP-7',
  branch: 'stup-7-fix-the-users-login',
  body: 'Steps:\n\n1. Sign in\n',
};

beforeEach(() => {
  showToast.mockReset();
  showErrorToast.mockReset();
  globalThis.localStorage.clear();
});

describe('codingPrompt', () => {
  it('fills the fixed template with the issue', () => {
    expect(codingPrompt(ISSUE)).toBe(
      [
        "Work on STUP-7: Fix the user's login",
        'Issue: https://standupless.dev/acme/issue/STUP-7\nBranch: stup-7-fix-the-users-login',
        'Use the branch stup-7-fix-the-users-login, creating it if it does not exist yet.',
        '## Description\n\nSteps:\n\n1. Sign in',
      ].join('\n\n')
    );
  });

  it('says there is no description when the body is empty', () => {
    expect(codingPrompt({ ...ISSUE, body: null })).toContain(
      '## Description\n\nNo description.'
    );
  });
});

describe('codingCommand', () => {
  it('switches to the branch and starts the tool with the quoted prompt', () => {
    const command = codingCommand('claude-code', ISSUE);
    expect(
      command.startsWith(
        "(git switch 'stup-7-fix-the-users-login' 2>/dev/null || git switch -c 'stup-7-fix-the-users-login') && claude '"
      )
    ).toBe(true);
    expect(command).toContain(shellQuote(codingPrompt(ISSUE)));
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('uses each tool its own program', () => {
    expect(codingCommand('vscode', ISSUE)).toContain('&& code chat ');
    expect(codingCommand('codex', ISSUE)).toContain('&& codex ');
  });
});

describe('codingDeepLink', () => {
  it('encodes the whole prompt into the Cursor link', () => {
    expect(codingDeepLink('cursor', ISSUE)).toBe(
      `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(codingPrompt(ISSUE))}`
    );
  });

  it('shortens a long description to fit the cap', () => {
    const link = codingDeepLink('cursor', {
      ...ISSUE,
      body: 'word '.repeat(5000),
    });
    expect(link.length).toBeLessThanOrEqual(MAX_DEEP_LINK_LENGTH);
    expect(decodeURIComponent(link)).toContain('Description shortened');
  });
});

describe('openInCodingTool', () => {
  it('copies the command for a tool without a scheme and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    openInCodingTool('claude-code', ISSUE);
    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        'Copied the Claude Code command. Run it in your repository.'
      );
    });
    expect(writeText).toHaveBeenCalledWith(codingCommand('claude-code', ISSUE));
  });

  it('opens the deep link for a tool with a scheme and says so', () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    openInCodingTool('cursor', ISSUE);
    expect(click).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Opening STUP-7 in Cursor');
    click.mockRestore();
  });
});

describe('the default tool', () => {
  it('starts on the default and remembers a pick in this browser', () => {
    expect(readDefaultCodingTool()).toBe(DEFAULT_CODING_TOOL);
    setDefaultCodingTool('cursor');
    expect(readDefaultCodingTool()).toBe('cursor');
    expect(globalThis.localStorage.getItem(CODING_TOOL_STORAGE_KEY)).toBe(
      'cursor'
    );
  });

  it('ignores a stored value that names no tool', () => {
    globalThis.localStorage.setItem(CODING_TOOL_STORAGE_KEY, 'notepad');
    expect(readDefaultCodingTool()).toBe(DEFAULT_CODING_TOOL);
  });
});
