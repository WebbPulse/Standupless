/**
 * Copying an issue's git branch name from the issue menu or its shortcut:
 * the copied text is the branch built from the key and title, and the toast
 * names it, whether or not the issue has linked pull requests. With the
 * workflow switches on, copying the branch of an issue that is not started
 * yet moves it to the team's first started status and assigns it to the
 * copier in one patch, and leaves a started, done or triaged issue alone.
 * Copying an issue as Markdown gives a linked heading, the properties that
 * are set and the description, the same text every time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusRead } from '../types/Api';
import {
  COPY_BRANCH_KEYS,
  branchStartPatch,
  copyBranchName,
  copyIssueMarkdown,
  issueMarkdown,
  type BranchWorkflow,
  type IssueMarkdownContext,
  type MarkdownIssue,
} from './copyIssue';
import { DEFAULT_PREFERENCES, setPreferences } from './preferences';

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
  setPreferences(DEFAULT_PREFERENCES);
});

const status = (
  id: string,
  category: StatusRead['category'],
  position: number,
  hidden?: boolean
): StatusRead => ({
  id,
  name: id,
  category,
  position,
  ...(hidden === undefined ? {} : { hidden }),
});

const STATUSES: StatusRead[] = [
  status('backlog', 'backlog', 0),
  status('todo', 'unstarted', 1),
  status('review', 'started', 3),
  status('hidden-start', 'started', 1.5, true),
  status('doing', 'started', 2),
  status('done', 'completed', 4),
  status('canceled', 'cancelled', 5),
];

const BOTH_ON: BranchWorkflow = {
  branchCopyStarts: true,
  branchCopyAssigns: true,
};

/** Stubs the clipboard so copies land. */
const landClipboard = (): void => {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });
};

describe('branchStartPatch', () => {
  it('starts and assigns an unassigned backlog or todo issue at once', () => {
    for (const statusId of ['backlog', 'todo']) {
      expect(
        branchStartPatch(
          { status_id: statusId, assignee_id: null },
          STATUSES,
          'me',
          BOTH_ON
        )
      ).toEqual({ status_id: 'doing', assignee_id: 'me' });
    }
  });

  it('leaves a started, done or canceled issue alone', () => {
    for (const statusId of ['doing', 'review', 'done', 'canceled']) {
      expect(
        branchStartPatch(
          { status_id: statusId, assignee_id: null },
          STATUSES,
          'me',
          BOTH_ON
        )
      ).toBeNull();
    }
  });

  it('leaves an issue waiting in triage alone', () => {
    expect(
      branchStartPatch(
        { status_id: 'backlog', assignee_id: null, in_triage: true },
        STATUSES,
        'me',
        BOTH_ON
      )
    ).toBeNull();
  });

  it('only assigns when moving to started is off', () => {
    expect(
      branchStartPatch(
        { status_id: 'todo', assignee_id: null },
        STATUSES,
        'me',
        { branchCopyStarts: false, branchCopyAssigns: true }
      )
    ).toEqual({ assignee_id: 'me' });
  });

  it('only moves the status when assigning is off', () => {
    expect(
      branchStartPatch(
        { status_id: 'todo', assignee_id: null },
        STATUSES,
        'me',
        { branchCopyStarts: true, branchCopyAssigns: false }
      )
    ).toEqual({ status_id: 'doing' });
  });

  it('keeps someone else assigned', () => {
    expect(
      branchStartPatch(
        { status_id: 'todo', assignee_id: 'them' },
        STATUSES,
        'me',
        BOTH_ON
      )
    ).toEqual({ status_id: 'doing' });
  });

  it('changes nothing with both switches off', () => {
    expect(
      branchStartPatch(
        { status_id: 'todo', assignee_id: null },
        STATUSES,
        'me',
        { branchCopyStarts: false, branchCopyAssigns: false }
      )
    ).toBeNull();
  });

  it('changes nothing when assigned and the team has no started status', () => {
    expect(
      branchStartPatch(
        { status_id: 'todo', assignee_id: 'them' },
        STATUSES.filter((item) => item.category !== 'started'),
        'me',
        BOTH_ON
      )
    ).toBeNull();
  });

  it('reads the stored switches by default', () => {
    setPreferences({ ...DEFAULT_PREFERENCES, branchCopyAssigns: false });

    expect(
      branchStartPatch({ status_id: 'todo', assignee_id: null }, STATUSES, 'me')
    ).toEqual({ status_id: 'doing' });
  });
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

  it('applies the workflow patch once the copy lands', async () => {
    landClipboard();
    const apply = vi.fn();

    copyBranchName('STUP-1', 'Fix login', {
      issue: { status_id: 'todo', assignee_id: null },
      statuses: STATUSES,
      currentUserId: 'me',
      apply,
    });

    await vi.waitFor(() => {
      expect(apply).toHaveBeenCalledWith({
        status_id: 'doing',
        assignee_id: 'me',
      });
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Copied stup-1-fix-login');
  });

  it('does not touch an issue that is already started', async () => {
    landClipboard();
    const apply = vi.fn();

    copyBranchName('STUP-1', 'Fix login', {
      issue: { status_id: 'doing', assignee_id: null },
      statuses: STATUSES,
      currentUserId: 'me',
      apply,
    });

    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Copied stup-1-fix-login');
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not touch the issue when the copy fails', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    const apply = vi.fn();

    copyBranchName('STUP-1', 'Fix login', {
      issue: { status_id: 'todo', assignee_id: null },
      statuses: STATUSES,
      currentUserId: 'me',
      apply,
    });

    await vi.waitFor(() => {
      expect(showErrorToast).toHaveBeenCalled();
    });
    expect(apply).not.toHaveBeenCalled();
  });
});

const MARKDOWN_CONTEXT: IssueMarkdownContext = {
  statuses: [{ id: 'st-1', name: 'In Progress' }],
  labels: [
    { id: 'lb-1', name: 'Bug' },
    { id: 'lb-2', name: 'Frontend' },
  ],
  people: [{ user_id: 'u-1', email: 'ada@example.com', display_name: 'ada' }],
  projects: [{ project_id: 'pr-1', name: 'Parity' }],
  cycles: [
    { cycle_id: 'cy-1', name: 'Sprint 4', number: 4 },
    { cycle_id: 'cy-2', name: '', number: 7 },
  ],
};

const BARE: MarkdownIssue = {
  key: 'ENG-7',
  title: 'Cache the token',
  body: null,
  status_id: 'st-1',
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  project_id: null,
  cycle_id: null,
};

const ISSUE_URL = 'https://app.example/acme/issue/ENG-7';

describe('issueMarkdown', () => {
  it('gives the heading and status alone for an issue with nothing else set', () => {
    expect(issueMarkdown(BARE, ISSUE_URL, MARKDOWN_CONTEXT)).toBe(
      `# [ENG-7 Cache the token](${ISSUE_URL})\n\n**Status:** In Progress\n`
    );
  });

  it('lists every set property in order, then the description as stored', () => {
    const full: MarkdownIssue = {
      ...BARE,
      body: 'Steps:\n\n- open it\n- [ ] check it\n\n',
      priority: 'high',
      assignee_id: 'u-1',
      label_ids: ['lb-2', 'lb-1'],
      project_id: 'pr-1',
      cycle_id: 'cy-1',
    };
    expect(issueMarkdown(full, ISSUE_URL, MARKDOWN_CONTEXT)).toBe(
      [
        `# [ENG-7 Cache the token](${ISSUE_URL})`,
        '**Status:** In Progress · **Priority:** High · **Assignee:** ada · ' +
          '**Labels:** Frontend, Bug · **Project:** Parity · **Cycle:** Sprint 4',
        'Steps:\n\n- open it\n- [ ] check it',
      ].join('\n\n') + '\n'
    );
  });

  it('names an unnamed cycle by its number and skips ids it cannot resolve', () => {
    const issue: MarkdownIssue = {
      ...BARE,
      title: 'Fix [draft] links',
      status_id: 'gone',
      assignee_id: 'u-gone',
      label_ids: ['lb-gone'],
      project_id: 'pr-gone',
      cycle_id: 'cy-2',
      body: '   ',
    };
    expect(issueMarkdown(issue, ISSUE_URL, MARKDOWN_CONTEXT)).toBe(
      `# [ENG-7 Fix \\[draft\\] links](${ISSUE_URL})\n\n**Cycle:** Cycle 7\n`
    );
  });
});

describe('copyIssueMarkdown', () => {
  it('copies the Markdown and confirms it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    copyIssueMarkdown(BARE, ISSUE_URL, MARKDOWN_CONTEXT);
    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Issue copied as Markdown');
    });
    expect(writeText).toHaveBeenCalledWith(
      issueMarkdown(BARE, ISSUE_URL, MARKDOWN_CONTEXT)
    );
  });
});
