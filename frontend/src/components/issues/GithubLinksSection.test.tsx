/**
 * The linked pull requests on an issue. Covers that the section disappears
 * rather than showing an empty panel on every issue of a workspace that has not
 * connected GitHub, that each link points at the pull request, and that a
 * closing link says so since that is what drives the merge transition.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubIssueLinkRead } from '../../types/Api';
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
  return { ...actual, listIssueLinks: () => listIssueLinks() };
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
