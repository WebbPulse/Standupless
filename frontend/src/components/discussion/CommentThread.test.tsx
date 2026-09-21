/**
 * The comment thread. Covers that posting and editing send what the contract
 * asks for, that a reply carries its parent, that the edit and delete controls
 * are offered only to the people allowed to use them, and that replies render
 * under their root rather than as separate roots.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentListRead, CommentRead } from '../../types/Api';
import CommentThread from './CommentThread';

const listComments = vi.fn<(query: unknown) => Promise<CommentListRead>>();
const createComment = vi.fn<(body: unknown) => Promise<CommentRead>>();
const updateComment =
  vi.fn<(id: string, issueId: string, body: string) => Promise<CommentRead>>();
const deleteComment = vi.fn<(id: string, issueId: string) => Promise<void>>();

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    listComments: (_w: string, _i: string, query: unknown) =>
      listComments(query),
    createComment: (_w: string, _i: string, body: unknown) =>
      createComment(body),
    updateComment: (_w: string, id: string, issueId: string, body: string) =>
      updateComment(id, issueId, body),
    deleteComment: (_w: string, id: string, issueId: string) =>
      deleteComment(id, issueId),
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

/** Builds a comment in the shape the contract answers with. */
const comment = (over: Partial<CommentRead> = {}): CommentRead => ({
  comment_id: 'c-1',
  issue_id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'proj-1',
  body: 'The cache never warms',
  parent_comment_id: null,
  author_id: 'user-1',
  author: {
    user_id: 'user-1',
    display_name: 'Ada',
    email: 'ada@example.com',
  },
  mentions: [],
  reactions: [],
  reply_count: 0,
  created_at: '2026-09-17T00:00:00Z',
  edited_at: null,
  ...over,
});

const renderThread = (
  over: Partial<React.ComponentProps<typeof CommentThread>> = {}
) =>
  render(
    <CommentThread
      workspaceId="ws-1"
      issueId="iss-1"
      currentUserId="user-1"
      canComment
      isAdmin={false}
      {...over}
    />
  );

beforeEach(() => {
  listComments.mockReset();
  createComment.mockReset();
  updateComment.mockReset();
  deleteComment.mockReset();
  listComments.mockResolvedValue({
    comments: [comment()],
    next_cursor: null,
  });
  createComment.mockResolvedValue(comment({ comment_id: 'c-new' }));
  updateComment.mockResolvedValue(comment({ body: 'Edited' }));
  deleteComment.mockResolvedValue(undefined);
});

describe('comment thread', () => {
  it('shows the comments it read', async () => {
    renderThread();

    expect(
      await screen.findByText('The cache never warms')
    ).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });

  it('says so when the thread is empty', async () => {
    listComments.mockResolvedValue({ comments: [], next_cursor: null });
    renderThread();

    expect(await screen.findByText('No comments yet.')).toBeInTheDocument();
  });

  it('posts a comment with no parent when it is not a reply', async () => {
    const user = userEvent.setup();
    renderThread();

    await screen.findByText('The cache never warms');
    await user.type(screen.getByLabelText('Write a comment'), 'Looks right');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => {
      expect(createComment).toHaveBeenCalledWith({ body: 'Looks right' });
    });
  });

  it('carries the parent when the composer is replying', async () => {
    const user = userEvent.setup();
    renderThread();

    await screen.findByText('The cache never warms');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByLabelText('Write a comment'), 'Agreed');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => {
      expect(createComment).toHaveBeenCalledWith({
        body: 'Agreed',
        parent_comment_id: 'c-1',
      });
    });
  });

  it('sends the issue id with an edit, which the contract puts in the body', async () => {
    const user = userEvent.setup();
    renderThread();

    await screen.findByText('The cache never warms');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit comment');
    await user.clear(box);
    await user.type(box, 'Now it warms');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateComment).toHaveBeenCalledWith(
        'c-1',
        'iss-1',
        'Now it warms'
      );
    });
  });

  it('deletes a comment through the issue scoped route', async () => {
    const user = userEvent.setup();
    renderThread();

    await screen.findByText('The cache never warms');
    await user.click(screen.getByRole('button', { name: 'Delete comment' }));

    await waitFor(() => {
      expect(deleteComment).toHaveBeenCalledWith('c-1', 'iss-1');
    });
  });

  it('offers neither edit nor delete on a comment by someone else', async () => {
    listComments.mockResolvedValue({
      comments: [
        comment({
          author_id: 'user-2',
          author: {
            user_id: 'user-2',
            display_name: 'Grace',
            email: 'grace@example.com',
          },
        }),
      ],
      next_cursor: null,
    });
    renderThread();

    await screen.findByText('The cache never warms');
    expect(
      screen.queryByRole('button', { name: 'Edit' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete comment' })
    ).not.toBeInTheDocument();
  });

  it('lets a team admin delete a comment they did not write', async () => {
    listComments.mockResolvedValue({
      comments: [
        comment({
          author_id: 'user-2',
          author: {
            user_id: 'user-2',
            display_name: 'Grace',
            email: 'grace@example.com',
          },
        }),
      ],
      next_cursor: null,
    });
    renderThread({ isAdmin: true });

    await screen.findByText('The cache never warms');
    expect(
      screen.getByRole('button', { name: 'Delete comment' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit' })
    ).not.toBeInTheDocument();
  });

  it('hides the composer from someone who may only read', async () => {
    renderThread({ canComment: false });

    await screen.findByText('The cache never warms');
    expect(screen.queryByLabelText('Write a comment')).not.toBeInTheDocument();
  });

  it('nests a reply under its root rather than listing it separately', async () => {
    listComments.mockResolvedValue({
      comments: [
        comment(),
        comment({
          comment_id: 'c-2',
          parent_comment_id: 'c-1',
          body: 'It warms on the second hit',
        }),
      ],
      next_cursor: null,
    });
    renderThread();

    const roots = await screen.findAllByRole('listitem');
    const first = roots[0];
    expect(first).toBeDefined();
    expect(
      within(first as HTMLElement).getByText('It warms on the second hit')
    ).toBeInTheDocument();
  });

  it('does not offer a reply on a reply, which the contract refuses', async () => {
    listComments.mockResolvedValue({
      comments: [
        comment(),
        comment({
          comment_id: 'c-2',
          parent_comment_id: 'c-1',
          body: 'It warms on the second hit',
        }),
      ],
      next_cursor: null,
    });
    renderThread();

    await screen.findByText('It warms on the second hit');
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
  });

  it('surfaces a failed read', async () => {
    listComments.mockRejectedValue(new Error('boom'));
    renderThread();

    expect(
      await screen.findByText('Could not load the comments.')
    ).toBeInTheDocument();
  });
});
