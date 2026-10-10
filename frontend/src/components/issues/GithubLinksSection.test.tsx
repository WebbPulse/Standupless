/**
 * The linked pull requests on an issue. Covers that the section disappears
 * rather than showing an empty panel on every issue without a linked pull
 * request, that each link points at the pull request, that a closing link says
 * so since that is what drives the merge transition, that each state's icon
 * carries its GitHub color, and that the synced GitHub issue is not listed here.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubIssueLinkRead } from '../../types/Api';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../hooks/useShortcuts';
import GithubLinksSection from './GithubLinksSection';

const listIssueLinks = vi.fn<
  () => Promise<{
    items: GithubIssueLinkRead[];
    next_cursor: string | null;
  }>
>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listIssueLinks: () => listIssueLinks(),
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** One link in the shape the contract answers with. */
const link = (
  over: Partial<GithubIssueLinkRead> = {}
): GithubIssueLinkRead => ({
  link_id: 'PR_node#iss-1',
  issue_id: 'iss-1',
  issue_key: 'ENG-1',
  repository_full_name: 'WebbPulse/standupless',
  pr_number: 7,
  pr_title: 'Boot the engine',
  pr_url: 'https://github.com/WebbPulse/standupless/pull/7',
  pr_state: 'open',
  author_login: 'someone',
  closes_issue: false,
  applied_status_id: null,
  linked_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  ...over,
});

beforeEach(() => {
  listIssueLinks.mockReset();
  listIssueLinks.mockResolvedValue({ items: [link()], next_cursor: null });
});

describe('the linked pull requests', () => {
  it('lists a link pointing at the pull request', async () => {
    render(<GithubLinksSection workspaceId="ws-1" issueId="iss-1" />);

    expect(
      await screen.findByRole('region', { name: 'Pull requests' })
    ).toBeInTheDocument();
    const anchor = await screen.findByRole('link', {
      name: /WebbPulse\/standupless#7 Boot the engine/,
    });
    expect(anchor).toHaveAttribute(
      'href',
      'https://github.com/WebbPulse/standupless/pull/7'
    );
    expect(screen.getByText(/Open, opened by someone/)).toBeInTheDocument();
  });

  it('says when a pull request closes the issue', async () => {
    listIssueLinks.mockResolvedValue({
      items: [link({ closes_issue: true, pr_state: 'merged' })],
      next_cursor: null,
    });
    render(<GithubLinksSection workspaceId="ws-1" issueId="iss-1" />);

    expect(
      await screen.findByText(/Merged, opened by someone, closes this issue/)
    ).toBeInTheDocument();
  });

  it.each([
    ['open', 'text-success'],
    ['draft', 'text-text-faint'],
    ['merged', 'text-merged'],
    ['closed', 'text-danger'],
  ] as const)('colors a %s pull request icon', async (state, colorClass) => {
    listIssueLinks.mockResolvedValue({
      items: [link({ pr_state: state })],
      next_cursor: null,
    });
    const { container } = render(
      <GithubLinksSection workspaceId="ws-1" issueId="iss-1" />
    );

    await screen.findByRole('link', { name: /Boot the engine/ });
    const icon = container.querySelector(`[data-pr-state="${state}"]`);
    expect(icon).not.toBeNull();
    expect(icon).toHaveClass(colorClass);
  });

  it('renders nothing when the issue has no linked pull request', async () => {
    listIssueLinks.mockResolvedValue({ items: [], next_cursor: null });
    const { container } = render(
      <GithubLinksSection workspaceId="ws-1" issueId="iss-1" />
    );

    await vi.waitFor(() => {
      expect(listIssueLinks).toHaveBeenCalled();
    });
    expect(screen.queryByText('Pull requests')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the branch name', () => {
  it('copies a branch name built from the key and title', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(
      <GithubLinksSection
        workspaceId="ws-1"
        issueId="iss-1"
        issueKey="GHS-1"
        title="Fix login"
      />
    );

    await user.click(
      await screen.findByRole('button', { name: 'Copy git branch name' })
    );

    expect(writeText).toHaveBeenCalledWith('ghs-1-fix-login');
  });

  it('hides the section but keeps the shortcut when nothing is linked', async () => {
    listIssueLinks.mockResolvedValue({ items: [], next_cursor: null });
    const registry = createShortcutRegistry();
    const { container } = render(
      <ShortcutRegistryContext.Provider value={registry}>
        <GithubLinksSection
          workspaceId="ws-1"
          issueId="iss-1"
          issueKey="GHS-1"
          title="Fix login"
        />
      </ShortcutRegistryContext.Provider>
    );

    await vi.waitFor(() => {
      expect(listIssueLinks).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
    expect(registry.list().map((shortcut) => shortcut.label)).toContain(
      'Copy git branch name'
    );
  });
});

/** One entry of a stack of `size`, with the stack's aggregate state. */
const stacked = (
  position: number,
  over: Partial<GithubIssueLinkRead> = {},
  size = 3
): GithubIssueLinkRead =>
  link({
    link_id: `PR_${String(position)}#iss-1`,
    pr_number: 10 + position,
    pr_title: `Part ${String(position)}`,
    pr_url: `https://github.com/WebbPulse/standupless/pull/${String(10 + position)}`,
    review_state: 'approved',
    ci_state: 'success',
    stack: {
      stack_id: 'repo:11',
      position,
      size,
      pr_state: 'open',
      review_state: 'approved',
      ci_state: 'pending',
    },
    ...over,
  });

describe('stacked pull requests', () => {
  it('shows a three pull request stack as one collapsible row', async () => {
    const user = userEvent.setup();
    listIssueLinks.mockResolvedValue({
      items: [stacked(3), stacked(2, { ci_state: 'pending' }), stacked(1)],
      next_cursor: null,
    });
    render(<GithubLinksSection workspaceId="ws-1" issueId="iss-1" />);

    const toggle = await screen.findByRole('button', {
      name: /Stack of 3 pull requests/,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /#11 Part 1/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /#12 Part 2/ })).toBeNull();
    expect(screen.getByRole('img', { name: 'Approved' })).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Checks running' })
    ).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const entries = screen.getByRole('list', {
      name: /Pull requests in the stack/,
    });
    const names = Array.from(entries.querySelectorAll('a')).map(
      (anchor) => anchor.textContent
    );
    expect(names).toEqual([
      'WebbPulse/standupless#11 Part 1',
      'WebbPulse/standupless#12 Part 2',
      'WebbPulse/standupless#13 Part 3',
    ]);
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
  });

  it('leads a stack with its lowest open entry once the bottom one merged', async () => {
    listIssueLinks.mockResolvedValue({
      items: [
        stacked(1, { pr_state: 'merged' }),
        stacked(2, { review_state: 'changes_requested', ci_state: 'failure' }),
        stacked(3),
      ],
      next_cursor: null,
    });
    render(<GithubLinksSection workspaceId="ws-1" issueId="iss-1" />);

    expect(
      await screen.findByRole('link', { name: /#12 Part 2/ })
    ).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /#11 Part 1/ })).toBeNull();
  });

  it('keeps an unstacked pull request beside a stack as its own row', async () => {
    listIssueLinks.mockResolvedValue({
      items: [
        stacked(1, {}, 2),
        stacked(2, {}, 2),
        link({ ci_state: 'failure', review_state: 'none' }),
      ],
      next_cursor: null,
    });
    render(<GithubLinksSection workspaceId="ws-1" issueId="iss-1" />);

    expect(
      await screen.findByRole('link', { name: /#7 Boot the engine/ })
    ).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Checks failed' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Stack of/ })).toHaveLength(1);
  });
});
