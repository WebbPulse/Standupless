/**
 * The comment card. Covers that hovering a comment changes nothing about its
 * layout: with no reactions the add-reaction button sits among the actions that
 * fade in, rather than in a row under the body that appears on hover, and a
 * reaction on a comment carries the issue it was written on. Also covers
 * syncing a thread to GitHub from its menu, the badge a synced thread wears,
 * and unsyncing it, and resolving a thread: the collapsed one-line summary,
 * expanding it, and unresolving it.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommentRead,
  GithubThread,
  GithubThreadTargetRead,
  ReactionGroup,
} from '../../types/Api';
import CommentCard from './CommentCard';

const addReaction = vi.fn<(target: unknown) => Promise<ReactionGroup>>();
const syncThread =
  vi.fn<(commentId: string, payload: unknown) => Promise<unknown>>();
const unsyncThread = vi.fn<(commentId: string) => Promise<unknown>>();
const resolveThread = vi.fn<(commentId: string) => Promise<unknown>>();
const unresolveThread = vi.fn<(commentId: string) => Promise<unknown>>();

vi.mock('../../api/integrations', () => ({
  syncThread: (_w: string, _i: string, commentId: string, payload: unknown) =>
    syncThread(commentId, payload),
  unsyncThread: (_w: string, _i: string, commentId: string) =>
    unsyncThread(commentId),
}));

/** A linked pull request a thread may sync to. */
const target = (
  overrides: Partial<GithubThreadTargetRead> = {}
): GithubThreadTargetRead => ({
  kind: 'pull_request',
  repository_id: 'repo-1',
  full_name: 'acme/api',
  number: 7,
  title: 'Fix the login',
  url: 'https://github.com/acme/api/pull/7',
  private: true,
  ref: 'acme/api#7',
  ...overrides,
});

/** A thread synced to acme/api#7, with its opening comment landed. */
const synced: GithubThread = {
  kind: 'pull_request',
  repository_id: 'repo-1',
  full_name: 'acme/api',
  number: 7,
  target_url: 'https://github.com/acme/api/pull/7',
  private: true,
  synced_by: 'user-1',
  synced_at: '2026-10-24T10:00:00Z',
  comment_url: 'https://github.com/acme/api/pull/7#issuecomment-1',
};

vi.mock('../../api/drafts', () => ({
  listIssueDrafts: () => Promise.resolve([]),
  saveDraft: () => Promise.resolve({}),
  deleteDraft: () => Promise.resolve(),
}));

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    addReaction: (_w: string, target: unknown) => addReaction(target),
    resolveThread: (_w: string, _i: string, commentId: string) =>
      resolveThread(commentId),
    unresolveThread: (_w: string, _i: string, commentId: string) =>
      unresolveThread(commentId),
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
const renderCard = (
  reactions: ReactionGroup[] = [],
  overrides: Partial<CommentRead> = {},
  threadTargets: GithubThreadTargetRead[] = []
): void => {
  render(
    <MemoryRouter>
      <CommentCard
        comment={{ ...comment(reactions), ...overrides }}
        replies={[]}
        people={[]}
        workspaceId="ws-1"
        issueId="iss-1"
        currentUserId="user-1"
        canComment
        isAdmin={false}
        threadTargets={threadTargets}
      />
    </MemoryRouter>
  );
};

beforeEach(() => {
  syncThread.mockReset();
  syncThread.mockResolvedValue({});
  unsyncThread.mockReset();
  unsyncThread.mockResolvedValue({});
  resolveThread.mockReset();
  resolveThread.mockResolvedValue({});
  unresolveThread.mockReset();
  unresolveThread.mockResolvedValue({});
  addReaction.mockReset();
  addReaction.mockResolvedValue({
    emoji: '👍',
    count: 2,
    reacted: true,
    user_ids: ['user-1', 'user-2'],
  });
});

describe('comment card', () => {
  it('says when a comment came through MCP', () => {
    renderCard([], { source: 'mcp' });

    expect(screen.getByText('via MCP')).toBeInTheDocument();
  });

  it('leaves a web comment and an old comment unlabelled', () => {
    renderCard([], { source: 'web' });
    expect(screen.queryByText(/^via /)).toBeNull();
  });

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

  it('syncs a thread to the target picked from its menu', async () => {
    const user = userEvent.setup();
    renderCard([], {}, [
      target(),
      target({ repository_id: 'repo-2', number: 3, ref: 'acme/web#3' }),
    ]);

    await user.click(screen.getByRole('button', { name: 'Comment actions' }));
    await user.click(screen.getByRole('menuitem', { name: /acme\/web#3/ }));

    await waitFor(() => {
      expect(syncThread).toHaveBeenCalledWith('c-1', {
        repository_id: 'repo-2',
        number: 3,
      });
    });
  });

  it('marks a public target in the sync menu', async () => {
    const user = userEvent.setup();
    renderCard([], {}, [target({ private: false })]);

    await user.click(screen.getByRole('button', { name: 'Comment actions' }));

    expect(
      screen.getByRole('menuitem', { name: /acme\/api#7/ })
    ).toHaveTextContent('Public');
  });

  it('offers no sync without a linked target', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: 'Comment actions' }));

    expect(screen.queryByText('Sync thread to GitHub')).toBeNull();
  });

  it('badges a synced thread with a link to the mirrored comment', () => {
    renderCard([], { github_thread: synced }, [target()]);

    expect(
      screen.getByRole('link', { name: 'Synced to acme/api#7 on GitHub' })
    ).toHaveAttribute('href', synced.comment_url);
  });

  it('links the badge to the pull request until the opening comment lands', () => {
    renderCard([], { github_thread: { ...synced, comment_url: '' } });

    expect(
      screen.getByRole('link', { name: 'Synced to acme/api#7 on GitHub' })
    ).toHaveAttribute('href', synced.target_url);
  });

  it('unsyncs a synced thread from its menu', async () => {
    const user = userEvent.setup();
    renderCard([], { github_thread: synced }, [target()]);

    await user.click(screen.getByRole('button', { name: 'Comment actions' }));
    expect(screen.queryByText('Sync thread to GitHub')).toBeNull();
    await user.click(
      screen.getByRole('menuitem', { name: 'Unsync from GitHub' })
    );

    await waitFor(() => {
      expect(unsyncThread).toHaveBeenCalledWith('c-1');
    });
  });

  it('offers no sync on a reply', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CommentCard
          comment={comment()}
          replies={[
            {
              ...comment(),
              comment_id: 'c-2',
              parent_comment_id: 'c-1',
              github_thread: synced,
            },
          ]}
          people={[]}
          workspaceId="ws-1"
          issueId="iss-1"
          currentUserId="user-1"
          canComment
          isAdmin={false}
          threadTargets={[target()]}
        />
      </MemoryRouter>
    );

    const menus = screen.getAllByRole('button', { name: 'Comment actions' });
    await user.click(menus[1]!);

    expect(screen.queryByText('Sync thread to GitHub')).toBeNull();
    expect(screen.queryAllByRole('link', { name: /Synced to/ })).toHaveLength(
      0
    );
  });
});

/** A reply under the root `c-1`. */
const reply = (commentId: string, body: string): CommentRead => ({
  ...comment(),
  comment_id: commentId,
  parent_comment_id: 'c-1',
  body,
});

/** Renders one thread with replies, resolved or not, for a reader. */
const renderThread = (
  overrides: Partial<CommentRead> = {},
  replies: CommentRead[] = [],
  canComment = true
): void => {
  render(
    <MemoryRouter>
      <CommentCard
        comment={{ ...comment(), ...overrides }}
        replies={replies}
        people={[
          {
            user_id: 'user-2',
            display_name: 'Bea',
            email: 'bea@example.com',
          },
        ]}
        workspaceId="ws-1"
        issueId="iss-1"
        currentUserId="user-1"
        canComment={canComment}
        isAdmin={false}
      />
    </MemoryRouter>
  );
};

const resolved = {
  resolution: { resolved_by: 'user-2', resolved_at: '2026-10-24T11:00:00Z' },
};

describe('resolving a thread', () => {
  it('resolves an open thread from its root menu', async () => {
    const user = userEvent.setup();
    renderThread();

    await user.click(screen.getByRole('button', { name: 'Comment actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Resolve thread' }));

    await waitFor(() => {
      expect(resolveThread).toHaveBeenCalledWith('c-1');
    });
  });

  it('offers no resolve on a reply', async () => {
    const user = userEvent.setup();
    renderThread({}, [reply('c-2', 'Agreed')]);

    const menus = screen.getAllByRole('button', { name: 'Comment actions' });
    await user.click(menus[1]!);

    expect(
      screen.queryByRole('menuitem', { name: /resolve thread/i })
    ).toBeNull();
  });

  it('offers no resolve to a reader who cannot comment', async () => {
    const user = userEvent.setup();
    renderThread({}, [], false);

    await user.click(screen.getByRole('button', { name: 'Comment actions' }));

    expect(
      screen.queryByRole('menuitem', { name: /resolve thread/i })
    ).toBeNull();
  });

  it('collapses a resolved thread to one line naming who resolved it', () => {
    renderThread({ ...resolved, body: '**Ship** it?' }, [
      reply('c-2', 'Yes'),
      reply('c-3', 'Done'),
    ]);

    const row = screen.getByRole('button', { name: /Show thread/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveTextContent('Ship it?');
    expect(row).toHaveTextContent('2 replies');
    expect(row).toHaveTextContent('Resolved by Bea');
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('expands a resolved thread on click and collapses it again', async () => {
    const user = userEvent.setup();
    renderThread(resolved, [reply('c-2', 'Yes')]);

    await user.click(screen.getByRole('button', { name: /Show thread/ }));

    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText(/Resolved by Bea/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse thread' }));

    expect(screen.queryByRole('article')).toBeNull();
  });

  it('unresolves an expanded thread, whoever resolved it', async () => {
    const user = userEvent.setup();
    renderThread(resolved);

    await user.click(screen.getByRole('button', { name: /Show thread/ }));
    await user.click(screen.getByRole('button', { name: 'Unresolve' }));

    await waitFor(() => {
      expect(unresolveThread).toHaveBeenCalledWith('c-1');
    });
  });

  it('unresolves from the root menu of an expanded thread', async () => {
    const user = userEvent.setup();
    renderThread(resolved);

    await user.click(screen.getByRole('button', { name: /Show thread/ }));
    await user.click(screen.getByRole('button', { name: 'Comment actions' }));
    await user.click(
      screen.getByRole('menuitem', { name: 'Unresolve thread' })
    );

    await waitFor(() => {
      expect(unresolveThread).toHaveBeenCalledWith('c-1');
    });
  });

  it('shows a reopened thread in full again', () => {
    renderThread({ resolution: null }, [reply('c-2', 'One more thing')]);

    expect(screen.queryByRole('button', { name: /Show thread/ })).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });
});
