/**
 * The anonymous share reader. The load-bearing behaviour is the shape of the
 * read: the target is resolved first so the page knows which of the two
 * follow-up reads to make, and a token that does not resolve renders a plain
 * not-found with no detail and nothing inviting the reader to sign in, since
 * signing in would not widen what the link grants.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SharedIssueRead,
  SharedTargetRead,
  SharedViewPageRead,
} from '../../types/Api';
import SharedView from './SharedView';

const getSharedTarget = vi.fn<(token: string) => Promise<SharedTargetRead>>();
const getSharedIssue = vi.fn<(token: string) => Promise<SharedIssueRead>>();
const listSharedViewIssues =
  vi.fn<(token: string, query: unknown) => Promise<SharedViewPageRead>>();

vi.mock('../../api/access', () => ({
  getSharedTarget: (token: string) => getSharedTarget(token),
  getSharedIssue: (token: string) => getSharedIssue(token),
  listSharedViewIssues: (token: string, query: unknown) =>
    listSharedViewIssues(token, query),
}));

/** The target an issue share resolves to. */
const issueTarget: SharedTargetRead = {
  target_type: 'issue',
  title: 'Boot the engine',
  workspace_name: 'Engineering',
  project_name: 'Platform',
  shared_at: '2026-09-18T00:00:00Z',
};

/** The target a view share resolves to. */
const viewTarget: SharedTargetRead = {
  target_type: 'view',
  title: 'This sprint',
  workspace_name: 'Engineering',
  project_name: 'Platform',
  shared_at: '2026-09-18T00:00:00Z',
};

/** The one issue an issue share reads. */
const issue: SharedIssueRead = {
  issue_key: 'ENG-1',
  title: 'Boot the engine',
  body: 'It will not start.',
  status: { name: 'In progress', category: 'started', color: '#3b82f6' },
  priority: 'high',
  labels: [{ name: 'bug', color: '#ef4444' }],
  estimate: 3,
  start_date: null,
  due_date: null,
  assignee_name: 'Someone',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  comments: [
    {
      author_name: 'Someone',
      body: 'Looking at it.',
      created_at: '2026-09-18T01:00:00Z',
    },
  ],
};

/** One page of a view share. */
const page = (over: Partial<SharedViewPageRead> = {}): SharedViewPageRead => ({
  issues: [
    {
      issue_key: 'ENG-2',
      title: 'Wire the ignition',
      status: { name: 'Todo', category: 'unstarted', color: '#64748b' },
      priority: 'medium',
      assignee_name: null,
      updated_at: '2026-09-18T00:00:00Z',
    },
  ],
  next_cursor: null,
  ...over,
});

/** Mounts the page at `/shared/:token`, which is where the route table puts it. */
const renderPage = (token = 'shr_abcdef') =>
  render(
    <MemoryRouter initialEntries={[`/shared/${token}`]}>
      <Routes>
        <Route path="/shared/:token" element={<SharedView />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  getSharedTarget.mockReset();
  getSharedIssue.mockReset();
  listSharedViewIssues.mockReset();
});

describe('an issue share', () => {
  beforeEach(() => {
    getSharedTarget.mockResolvedValue(issueTarget);
    getSharedIssue.mockResolvedValue(issue);
  });

  it('resolves the target first, then reads the issue', async () => {
    renderPage();

    expect(await screen.findByText('It will not start.')).toBeInTheDocument();
    expect(getSharedTarget).toHaveBeenCalledWith('shr_abcdef');
    expect(getSharedIssue).toHaveBeenCalledWith('shr_abcdef');
    expect(listSharedViewIssues).not.toHaveBeenCalled();
  });

  it('renders the heading the target carries', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Boot the engine', level: 1 })
    ).toBeInTheDocument();
    expect(screen.getByText('Engineering, Platform')).toBeInTheDocument();
  });

  it('renders the issue key, status, labels and assignee name', async () => {
    renderPage();

    expect(await screen.findByText('ENG-1')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText(/Assigned to Someone/)).toBeInTheDocument();
  });

  it('renders the comments the share exposes', async () => {
    renderPage();

    const body = await screen.findByText('Looking at it.');
    expect(body).toBeInTheDocument();
    const row = body.closest('li');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Someone');
  });

  it('says so when the issue has no comments', async () => {
    getSharedIssue.mockResolvedValue({ ...issue, comments: [] });
    renderPage();

    expect(
      await screen.findByText('There are no comments.')
    ).toBeInTheDocument();
  });

  it('never invites the reader to sign in for more', async () => {
    renderPage();

    await screen.findByText('It will not start.');
    expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/log in/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /sign/i })
    ).not.toBeInTheDocument();
  });
});

describe('a view share', () => {
  beforeEach(() => {
    getSharedTarget.mockResolvedValue(viewTarget);
    listSharedViewIssues.mockResolvedValue(page());
  });

  it('resolves the target first, then reads the listing', async () => {
    renderPage();

    expect(await screen.findByText('Wire the ignition')).toBeInTheDocument();
    expect(listSharedViewIssues).toHaveBeenCalledWith('shr_abcdef', {
      limit: 50,
    });
    expect(getSharedIssue).not.toHaveBeenCalled();
  });

  it('renders a row by its key, title, status and assignment', async () => {
    renderPage();

    expect(await screen.findByText('ENG-2')).toBeInTheDocument();
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByText(/Unassigned/)).toBeInTheDocument();
  });

  it('says so when the view selects nothing', async () => {
    listSharedViewIssues.mockResolvedValue(page({ issues: [] }));
    renderPage();

    expect(
      await screen.findByText('This view has no issues in it right now.')
    ).toBeInTheDocument();
  });

  it('offers no next page when the cursor is null', async () => {
    renderPage();

    await screen.findByText('Wire the ignition');
    expect(
      screen.queryByRole('button', { name: 'Load more' })
    ).not.toBeInTheDocument();
  });

  it('pages on the cursor the first read handed back', async () => {
    listSharedViewIssues.mockResolvedValueOnce(page({ next_cursor: 'c1' }));
    listSharedViewIssues.mockResolvedValueOnce(
      page({
        issues: [
          {
            issue_key: 'ENG-3',
            title: 'Check the spark',
            status: { name: 'Todo', category: 'unstarted', color: '#64748b' },
            priority: null,
            assignee_name: null,
            updated_at: '2026-09-18T00:00:00Z',
          },
        ],
        next_cursor: null,
      })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Check the spark')).toBeInTheDocument();
    expect(screen.getByText('Wire the ignition')).toBeInTheDocument();
    expect(listSharedViewIssues).toHaveBeenLastCalledWith('shr_abcdef', {
      cursor: 'c1',
      limit: 50,
    });
  });
});

describe('a token that does not resolve', () => {
  it('renders the not-found state with no detail in it', async () => {
    getSharedTarget.mockRejectedValue(new Error('404'));
    renderPage('shr_revoked');

    expect(
      await screen.findByRole('heading', { name: 'Link not found' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/revoked or it may have expired/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Engineering/)).not.toBeInTheDocument();
    expect(getSharedIssue).not.toHaveBeenCalled();
    expect(listSharedViewIssues).not.toHaveBeenCalled();
  });

  it('gives the same answer whatever the refusal was', async () => {
    getSharedTarget.mockRejectedValue(new Error('expired'));
    renderPage('shr_expired');

    expect(
      await screen.findByRole('heading', { name: 'Link not found' })
    ).toBeInTheDocument();
  });

  it('renders not-found when the follow-up read fails too', async () => {
    getSharedTarget.mockResolvedValue(issueTarget);
    getSharedIssue.mockRejectedValue(new Error('gone'));
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Link not found' })
    ).toBeInTheDocument();
  });

  it('reads nothing at all without a token in the path', async () => {
    render(
      <MemoryRouter initialEntries={['/shared/']}>
        <Routes>
          <Route path="/shared/:token?" element={<SharedView />} />
        </Routes>
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { name: 'Link not found' })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(getSharedTarget).not.toHaveBeenCalled();
    });
  });
});
