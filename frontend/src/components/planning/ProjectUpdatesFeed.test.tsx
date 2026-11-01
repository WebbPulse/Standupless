/**
 * The notice that someone just posted: the composer names a recent update and
 * leaves an old one out, and a post that raced another says so in its toast.
 * The editor and the cards are stubbed, since neither decides the notice.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusUpdateFeed } from '../../hooks/useProjectUpdates';
import type { Assignable } from '../../lib/issuePeople';
import type { ProjectHealth, StatusUpdateRead } from '../../types/Api';
import ProjectUpdatesFeed from './ProjectUpdatesFeed';

const showToast = vi.fn();

vi.mock('../../lib/toast', () => ({
  showToast: (...args: unknown[]): unknown => showToast(...args),
  showErrorToast: vi.fn(),
}));

vi.mock('./ProjectUpdateCard', () => ({
  default: () => <div />,
}));

vi.mock('./ProjectUpdateEditor', () => ({
  default: ({
    onSubmit,
  }: {
    onSubmit: (
      body: string,
      health: ProjectHealth,
      hideDetails: boolean
    ) => Promise<boolean>;
  }) => (
    <button
      type="button"
      onClick={() => {
        void onSubmit('Note', 'on_track', false);
      }}
    >
      Post update
    </button>
  ),
}));

const PEOPLE = [{ user_id: 'u1', display_name: 'Mo Member' }] as Assignable[];

/** An update by the one person on the list, posted `minutes` ago. */
const postedAgo = (minutes: number): StatusUpdateRead => ({
  update_id: `update-${String(minutes)}`,
  workspace_id: 'w1',
  body: 'Note',
  health: 'at_risk',
  author_id: 'u1',
  created_at: new Date(Date.now() - minutes * 60000).toISOString(),
  updated_at: new Date(Date.now() - minutes * 60000).toISOString(),
  edited_at: null,
  can_edit: true,
});

/** A feed holding `updates` whose create answers with `made`. */
const feedOf = (
  updates: StatusUpdateRead[],
  made: Partial<StatusUpdateRead> = {}
): StatusUpdateFeed => ({
  updates,
  latest: updates[0] ?? null,
  isLoading: false,
  error: null,
  isPaging: false,
  hasMore: false,
  loadMore: vi.fn(),
  create: vi.fn().mockResolvedValue({ ...postedAgo(0), ...made }),
  edit: vi.fn(),
  remove: vi.fn(),
});

/** Draws the feed with its composer open. */
const renderFeed = (feed: StatusUpdateFeed, composing = true): void => {
  render(
    <MemoryRouter>
      <ProjectUpdatesFeed
        feed={feed}
        people={PEOPLE}
        subject="initiative"
        canPost
        defaultHealth="on_track"
        composing={composing}
        onComposingChange={vi.fn()}
      />
    </MemoryRouter>
  );
};

describe('ProjectUpdatesFeed recent update notice', () => {
  beforeEach(() => {
    showToast.mockClear();
  });

  it('names an update posted in the last few minutes', () => {
    renderFeed(feedOf([postedAgo(2), postedAgo(10)]));
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(
      "Mo Member posted an update 2m ago, health At risk. Read it before posting, because the newest update sets the initiative's health."
    );
    expect(notice).not.toHaveTextContent('10m ago');
  });

  it('shows nothing when the newest update is older than the window', () => {
    renderFeed(feedOf([postedAgo(10)]));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing while the composer is closed', () => {
    renderFeed(feedOf([postedAgo(2)]), false);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says so in the toast when a post raced another one', async () => {
    const other = postedAgo(0);
    renderFeed(
      feedOf([], {
        recent_updates: [
          {
            update_id: other.update_id,
            author_id: 'u2',
            author_name: 'Ann Admin',
            health: 'off_track',
            created_at: other.created_at,
          },
        ],
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post update' }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        'Update posted. Ann Admin posted an update just now, health Off track. Check the two do not repeat each other.'
      );
    });
  });

  it('confirms a plain post when nothing raced it', async () => {
    renderFeed(feedOf([]));
    await userEvent.click(screen.getByRole('button', { name: 'Post update' }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Update posted');
    });
  });
});
