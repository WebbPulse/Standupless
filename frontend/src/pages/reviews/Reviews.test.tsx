/**
 * Tests for the Reviews page: grouped rows, the unlinked and empty states, and
 * the keys that open a pull request or its linked issue.
 */

import type { ReactNode } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ReviewItemRead,
  ReviewsRead,
  WorkspaceRead,
} from '../../types/Api';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import Reviews from './Reviews';

const getReviews = vi.fn<(workspaceId: string) => Promise<ReviewsRead>>();

vi.mock('../../api/reviews', () => ({
  getReviews: (workspaceId: string) => getReviews(workspaceId),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

vi.mock('../../components/workspace/WorkspaceShell', () => ({
  default: ({
    title,
    children,
  }: {
    title?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context. */
const resolved = (): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** One pull request on the list. */
const item = (over: Partial<ReviewItemRead> = {}): ReviewItemRead => ({
  repository_id: '7',
  repository_full_name: 'acme/api',
  number: 42,
  title: 'Refactor the parser',
  url: 'https://github.com/acme/api/pull/42',
  author_login: 'olive',
  state: 'open',
  group: 'needs_review',
  review_state: 'pending',
  ci_state: 'success',
  created_at: '2026-10-01T09:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  issues: [
    { issue_id: 'iss-1', key: 'ENG-1', title: 'Cache the token', team_id: 't' },
  ],
  ...over,
});

/** A linked list holding the given rows. */
const listOf = (items: ReviewItemRead[]): ReviewsRead => ({
  github_linked: true,
  counts: {
    needs_review: items.filter((row) => row.group === 'needs_review').length,
    changes_requested: items.filter((row) => row.group === 'changes_requested')
      .length,
    approved: items.filter((row) => row.group === 'approved').length,
  },
  items,
});

/** Renders the page with an issue route to land on. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/reviews']}>
      <ShortcutProvider>
        <BoundKeys />
        <Routes>
          <Route path="/w/:slug/reviews" element={<Reviews />} />
          <Route path="/w/:slug/issues/:key" element={<p>Issue page</p>} />
        </Routes>
      </ShortcutProvider>
    </MemoryRouter>
  );

/** Dispatches one key the way the shortcut layer listens for it. */
const press = (key: string) => {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true })
    );
  });
};

beforeEach(() => {
  getReviews.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reviews', () => {
  it('groups the pull requests by where they stand', async () => {
    getReviews.mockResolvedValue(
      listOf([
        item(),
        item({
          number: 43,
          title: 'Drop the old client',
          url: 'https://github.com/acme/api/pull/43',
          group: 'approved',
          review_state: 'approved',
          issues: [],
        }),
      ])
    );
    renderPage();

    const needs = await screen.findByRole('list', {
      name: 'Needs your review',
    });
    expect(
      within(needs).getByRole('link', { name: 'Refactor the parser' })
    ).toHaveAttribute('href', 'https://github.com/acme/api/pull/42');
    expect(within(needs).getByRole('link', { name: 'ENG-1' })).toHaveAttribute(
      'href',
      '/w/mine/issues/ENG-1'
    );
    expect(within(needs).getByText('api#42')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Approved' })).getByText(
        'Drop the old client'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Changes requested' })
    ).not.toBeInTheDocument();
    expect(getReviews).toHaveBeenCalledWith('ws-1');
  });

  it('asks an unlinked caller to link GitHub', async () => {
    getReviews.mockResolvedValue({ ...listOf([]), github_linked: false });
    renderPage();

    expect(
      await screen.findByText(
        'Link your GitHub account to see the pull requests waiting on your review.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Link GitHub' })).toHaveAttribute(
      'href',
      '/security'
    );
  });

  it('says when nothing is waiting', async () => {
    getReviews.mockResolvedValue(listOf([]));
    renderPage();

    expect(
      await screen.findByText('No pull requests are waiting on your review.')
    ).toBeInTheDocument();
  });

  it('opens the pull request on enter and its issue on o', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    getReviews.mockResolvedValue(listOf([item()]));
    renderPage();

    await screen.findByText('Refactor the parser');
    await keysBound('j');
    press('j');
    await keysBound('enter', 'o');
    press('Enter');

    expect(open).toHaveBeenCalledWith(
      'https://github.com/acme/api/pull/42',
      '_blank',
      'noopener,noreferrer'
    );

    press('o');

    expect(await screen.findByText('Issue page')).toBeInTheDocument();
  });
});
