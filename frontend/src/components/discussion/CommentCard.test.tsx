/**
 * The comment card. Covers that hovering a comment changes nothing about its
 * layout: with no reactions the add-reaction button sits among the actions that
 * fade in, rather than in a row under the body that appears on hover, and a
 * reaction on a comment carries the issue it was written on.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRead, ReactionGroup } from '../../types/Api';
import CommentCard from './CommentCard';

const addReaction = vi.fn<(target: unknown) => Promise<ReactionGroup>>();

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    addReaction: (_w: string, target: unknown) => addReaction(target),
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

/** One comment by the reader, with the reactions given. */
const comment = (reactions: ReactionGroup[] = []): CommentRead => ({
  comment_id: 'c-1',
  issue_id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  body: 'Looks good',
  parent_comment_id: null,
  author_id: 'user-1',
  author: { user_id: 'user-1', display_name: 'Ada', email: 'ada@example.com' },
  mentions: [],
  reactions,
  reply_count: 0,
  created_at: '2026-09-20T10:00:00Z',
  edited_at: null,
});

/** Renders one thread for a reader who may comment. */
const renderCard = (reactions: ReactionGroup[] = []): void => {
  render(
    <MemoryRouter>
      <CommentCard
        comment={comment(reactions)}
        replies={[]}
        people={[]}
        workspaceId="ws-1"
        issueId="iss-1"
        currentUserId="user-1"
        canComment
        isAdmin={false}
      />
    </MemoryRouter>
  );
};

beforeEach(() => {
  addReaction.mockReset();
  addReaction.mockResolvedValue({
    emoji: '👍',
    count: 2,
    reacted: true,
    user_ids: ['user-1', 'user-2'],
  });
});

describe('comment card', () => {
  it('keeps the add-reaction button among the hover actions when there are no reactions', () => {
    renderCard();

    const add = screen.getByRole('button', { name: 'Add a reaction' });
    expect(add.closest('header')).not.toBeNull();
    const article = screen.getByRole('article', { name: 'Comment by Ada' });
    expect(article.querySelector('.hidden')).toBeNull();
    expect(
      article.querySelector('[class*="group-hover/comment:block"]')
    ).toBeNull();
  });

  it('shows reactions under the body, always, once there are some', () => {
    renderCard([
      { emoji: '👍', count: 1, reacted: false, user_ids: ['user-2'] },
    ]);

    const add = screen.getByRole('button', { name: 'Add a reaction' });
    expect(add.closest('header')).toBeNull();
    expect(
      screen.getByRole('button', { name: /Thumbs up/ }).closest('header')
    ).toBeNull();
  });

  it('reacts to a comment with its issue id', async () => {
    const user = userEvent.setup();
    renderCard([
      { emoji: '👍', count: 1, reacted: false, user_ids: ['user-2'] },
    ]);

    await user.click(screen.getByRole('button', { name: /Thumbs up/ }));

    await waitFor(() => {
      expect(addReaction).toHaveBeenCalledWith({
        target_id: 'c-1',
        target_kind: 'comment',
        emoji: '👍',
        issue_id: 'iss-1',
      });
    });
  });
});
