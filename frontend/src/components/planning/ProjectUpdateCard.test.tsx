/**
 * A project update card's thread. Covers that the reaction bar shows the
 * update's groups with the reader's own pressed and toggles through the update
 * thread routes, that the reply toggle names the count and opens the replies
 * only when asked, that a reply posts through the shared editor and reacts on
 * itself by comment id, and that an initiative update carries no thread.
 *
 * The emoji dataset is loaded once before the tests, so its cold import is not
 * paid inside a wait.
 */

import type { Editor } from '@tiptap/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEmojiCatalog } from '../../lib/emojiCatalog';
import type {
  InitiativeUpdateRead,
  ProjectUpdateCommentRead,
  ProjectUpdateRead,
  ReactionGroup,
} from '../../types/Api';
import ProjectUpdateCard from './ProjectUpdateCard';

const listProjectUpdateComments =
  vi.fn<(...args: unknown[]) => Promise<ProjectUpdateCommentRead[]>>();
const createProjectUpdateComment =
  vi.fn<(...args: unknown[]) => Promise<ProjectUpdateCommentRead>>();
const addProjectUpdateReaction =
  vi.fn<(...args: unknown[]) => Promise<ReactionGroup>>();
const removeProjectUpdateReaction =
  vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('../../api/projectUpdateThreads', () => ({
  listProjectUpdateComments: (...args: unknown[]) =>
    listProjectUpdateComments(...args),
  createProjectUpdateComment: (...args: unknown[]) =>
    createProjectUpdateComment(...args),
  updateProjectUpdateComment: vi.fn(),
  deleteProjectUpdateComment: vi.fn(),
  addProjectUpdateReaction: (...args: unknown[]) =>
    addProjectUpdateReaction(...args),
  removeProjectUpdateReaction: (...args: unknown[]) =>
    removeProjectUpdateReaction(...args),
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

/** A project update with one reaction group the reader holds. */
const update = (over: Partial<ProjectUpdateRead> = {}): ProjectUpdateRead => ({
  update_id: 'upd-1',
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  body: 'Shipping on schedule',
  health: 'on_track',
  author_id: 'user-1',
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
  edited_at: null,
  can_edit: false,
  reactions: [{ emoji: '👍', count: 2, user_ids: ['me', 'u2'], reacted: true }],
  comment_count: 2,
  ...over,
});

/** One reply by someone else. */
const reply = (
  id: string,
  body: string,
  over: Partial<ProjectUpdateCommentRead> = {}
): ProjectUpdateCommentRead => ({
  comment_id: id,
  update_id: 'upd-1',
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  body,
  author_id: 'u2',
  author: {
    user_id: 'u2',
    display_name: 'Grace Hopper',
    email: 'grace@example.com',
  },
  mentions: [],
  reactions: [],
  created_at: '2026-10-20T01:00:00Z',
  edited_at: null,
  can_edit: false,
  ...over,
});

/** Renders one card with no-op edit and delete. */
const renderCard = (
  value: ProjectUpdateRead | InitiativeUpdateRead = update()
): void => {
  render(
    <ProjectUpdateCard
      update={value}
      people={[]}
      onEdit={() => Promise.resolve()}
      onDelete={() => Promise.resolve()}
    />
  );
};

beforeAll(async () => {
  await loadEmojiCatalog();
});

beforeEach(() => {
  listProjectUpdateComments.mockReset();
  createProjectUpdateComment.mockReset();
  addProjectUpdateReaction.mockReset();
  removeProjectUpdateReaction.mockReset();
  listProjectUpdateComments.mockResolvedValue([
    reply('c-1', 'Nice work'),
    reply('c-2', 'Agreed'),
  ]);
  addProjectUpdateReaction.mockResolvedValue({
    emoji: '🎉',
    count: 1,
    user_ids: ['me'],
    reacted: true,
  });
  removeProjectUpdateReaction.mockResolvedValue(undefined);
});

describe('project update thread', () => {
  it('shows the reaction groups with the reader’s own pressed', () => {
    renderCard();

    const thumbs = screen.getByRole('button', { name: /Thumbs up, 2 people/ });
    expect(thumbs).toHaveAttribute('aria-pressed', 'true');
  });

  it('takes the reader’s reaction back through the update route', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /Thumbs up/ }));

    await waitFor(() => {
      expect(removeProjectUpdateReaction).toHaveBeenCalledWith(
        'ws-1',
        'prj-1',
        'upd-1',
        { emoji: '👍' }
      );
    });
    expect(
      screen.getByRole('button', { name: /Thumbs up, 1 person/ })
    ).toHaveAttribute('aria-pressed', 'false');
    expect(addProjectUpdateReaction).not.toHaveBeenCalled();
  });

  it('keeps the replies closed until the toggle opens them', async () => {
    const user = userEvent.setup();
    renderCard();

    const toggle = screen.getByRole('button', { name: /2 replies/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(listProjectUpdateComments).not.toHaveBeenCalled();

    await user.click(toggle);

    const replies = await screen.findByRole('region', { name: 'Replies' });
    expect(await within(replies).findByText('Nice work')).toBeVisible();
    expect(within(replies).getByText('Agreed')).toBeVisible();
    expect(listProjectUpdateComments.mock.calls[0]?.slice(0, 3)).toEqual([
      'ws-1',
      'prj-1',
      'upd-1',
    ]);
    expect(
      screen.getByRole('button', { name: /Hide replies/ })
    ).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('button', { name: /Hide replies/ }));
    expect(screen.queryByRole('region', { name: 'Replies' })).toBeNull();
  });

  it('posts a reply through the shared editor', async () => {
    const user = userEvent.setup();
    listProjectUpdateComments.mockResolvedValue([]);
    createProjectUpdateComment.mockResolvedValue(reply('c-3', 'On it'));
    renderCard(update({ comment_count: 0 }));

    await user.click(screen.getByRole('button', { name: 'Reply' }));
    const surface = await screen.findByRole(
      'textbox',
      { name: 'Reply to update' },
      { timeout: 10_000 }
    );
    act(() => {
      (surface as HTMLElement & { editor: Editor }).editor.commands.setContent(
        'On it'
      );
    });
    const replies = screen.getByRole('region', { name: 'Replies' });
    await user.click(within(replies).getByRole('button', { name: /^Reply/ }));

    await waitFor(() => {
      expect(createProjectUpdateComment).toHaveBeenCalledWith(
        'ws-1',
        'prj-1',
        'upd-1',
        'On it'
      );
    });
  });

  it('reacts on a reply by its comment id', async () => {
    const user = userEvent.setup();
    listProjectUpdateComments.mockResolvedValue([
      reply('c-1', 'Nice work', {
        reactions: [
          { emoji: '🎉', count: 1, user_ids: ['u3'], reacted: false },
        ],
      }),
    ]);
    renderCard();

    await user.click(screen.getByRole('button', { name: /2 replies/ }));
    const replies = await screen.findByRole('region', { name: 'Replies' });
    await user.click(
      await within(replies).findByRole('button', { name: /Celebrate/ })
    );

    await waitFor(() => {
      expect(addProjectUpdateReaction).toHaveBeenCalledWith(
        'ws-1',
        'prj-1',
        'upd-1',
        { emoji: '🎉', comment_id: 'c-1' }
      );
    });
  });

  it('leaves an initiative update without a thread', () => {
    const initiativeUpdate: InitiativeUpdateRead = {
      update_id: 'upd-2',
      initiative_id: 'ini-1',
      workspace_id: 'ws-1',
      body: 'Initiative on track',
      health: 'on_track',
      author_id: 'user-1',
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T00:00:00Z',
      edited_at: null,
      can_edit: false,
    };
    renderCard(initiativeUpdate);

    expect(screen.queryByRole('button', { name: /replies|Reply/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Thumbs up/ })).toBeNull();
  });
});

describe('ProjectUpdateCard progress report', () => {
  const snapshot = {
    measure: 'issues' as const,
    completed: 8,
    total: 20,
    percent: 40,
    target_date: null,
    target_date_resolution: null,
    lead_id: null,
    lead_name: null,
    status: null,
    status_id: null,
    status_name: null,
    milestones: [],
  };

  it('shows the diff against the previous snapshot', () => {
    renderCard(
      update({
        snapshot: { ...snapshot, completed: 12, percent: 60 },
        previous_snapshot: snapshot,
      })
    );

    const report = screen.getByRole('list', { name: 'Progress report' });
    expect(
      within(report).getByText('Progress 40% to 60% (12 of 20 issues)')
    ).toBeTruthy();
  });

  it('shows a baseline for a first update', () => {
    renderCard(update({ snapshot, previous_snapshot: null }));

    expect(screen.getByText('Progress 40% (8 of 20 issues)')).toBeTruthy();
  });

  it('shows no report when its author hid it', () => {
    renderCard(update({ snapshot, hide_details: true }));
    expect(screen.queryByRole('list', { name: 'Progress report' })).toBeNull();
  });

  it('shows no report on an update from before snapshots', () => {
    renderCard(update());
    expect(screen.queryByRole('list', { name: 'Progress report' })).toBeNull();
  });
});
