/**
 * The reaction bar. Covers that a toggle picks PUT or DELETE from whether the
 * caller already reacted, that a comment target always carries its issue id
 * (without it the API answers 404, which is how comment reactions broke), that
 * the picker leads with the quick picks and finds any emoji by search, that
 * inline groups are used without a second read, and that an issue with no
 * inline groups reads them itself.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REACTION_EMOJI } from '../../lib/reactions';
import type { ReactionGroup } from '../../types/Api';
import ReactionBar from './ReactionBar';

const addReaction = vi.fn<(target: unknown) => Promise<ReactionGroup>>();
const removeReaction = vi.fn<(target: unknown) => Promise<void>>();
const listReactions = vi.fn<() => Promise<ReactionGroup[]>>();

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    addReaction: (_w: string, target: unknown) => addReaction(target),
    removeReaction: (_w: string, target: unknown) => removeReaction(target),
    listReactions: () => listReactions(),
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

/** A group the caller has not reacted to. */
const group = (over: Partial<ReactionGroup> = {}): ReactionGroup => ({
  emoji: '👍',
  count: 2,
  reacted: false,
  user_ids: ['user-2', 'user-3'],
  ...over,
});

beforeEach(() => {
  addReaction.mockReset();
  removeReaction.mockReset();
  listReactions.mockReset();
  addReaction.mockResolvedValue(group({ count: 3, reacted: true }));
  removeReaction.mockResolvedValue(undefined);
  listReactions.mockResolvedValue([]);
});

describe('reaction bar', () => {
  it('adds a reaction the caller has not made', async () => {
    const user = userEvent.setup();
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="c-1"
        targetKind="comment"
        issueId="iss-1"
        reactions={[group()]}
        canReact
        refetchKey={['comments', 'iss-1']}
      />
    );

    await user.click(screen.getByRole('button', { name: /Thumbs up/ }));

    await waitFor(() => {
      expect(addReaction).toHaveBeenCalledWith({
        target_id: 'c-1',
        target_kind: 'comment',
        emoji: '👍',
        issue_id: 'iss-1',
      });
    });
    expect(removeReaction).not.toHaveBeenCalled();
  });

  it('removes a reaction the caller already made', async () => {
    const user = userEvent.setup();
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="c-1"
        targetKind="comment"
        issueId="iss-1"
        reactions={[group({ reacted: true })]}
        canReact
        refetchKey={['comments', 'iss-1']}
      />
    );

    await user.click(screen.getByRole('button', { name: /Thumbs up/ }));

    await waitFor(() => {
      expect(removeReaction).toHaveBeenCalledWith({
        target_id: 'c-1',
        target_kind: 'comment',
        emoji: '👍',
        issue_id: 'iss-1',
      });
    });
    expect(addReaction).not.toHaveBeenCalled();
  });

  it('leads the picker with the quick picks', async () => {
    const user = userEvent.setup();
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="c-1"
        targetKind="comment"
        issueId="iss-1"
        reactions={[]}
        canReact
        refetchKey={['comments', 'iss-1']}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add a reaction' }));

    const quick = screen.getByRole('group', { name: 'Quick picks' });
    expect(within(quick).getAllByRole('button')).toHaveLength(
      REACTION_EMOJI.length
    );
    expect(REACTION_EMOJI).toHaveLength(24);
  });

  it('reacts with any emoji found by search, carrying the issue id', async () => {
    const user = userEvent.setup();
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="c-1"
        targetKind="comment"
        issueId="iss-1"
        reactions={[]}
        canReact
        refetchKey={['comments', 'iss-1']}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add a reaction' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Search emoji' }),
      'unicorn'
    );
    const results = await screen.findByRole('group', { name: 'Results' });
    await user.click(within(results).getByRole('button', { name: 'Unicorn' }));

    await waitFor(() => {
      expect(addReaction).toHaveBeenCalledWith({
        target_id: 'c-1',
        target_kind: 'comment',
        emoji: '🦄',
        issue_id: 'iss-1',
      });
    });
    expect(
      screen.queryByRole('dialog', { name: 'Choose a reaction' })
    ).not.toBeInTheDocument();
  });

  it('takes a reaction back when the picked emoji is already held', async () => {
    const user = userEvent.setup();
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="iss-1"
        targetKind="issue"
        reactions={[group({ emoji: '❤', reacted: true, count: 1 })]}
        canReact
        refetchKey={['issue', 'iss-1']}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add a reaction' }));
    const quick = screen.getByRole('group', { name: 'Quick picks' });
    await user.click(within(quick).getByRole('button', { name: 'Heart' }));

    await waitFor(() => {
      expect(removeReaction).toHaveBeenCalledWith({
        target_id: 'iss-1',
        target_kind: 'issue',
        emoji: '❤',
      });
    });
  });

  it('uses the inline groups without reading them again', async () => {
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="c-1"
        targetKind="comment"
        reactions={[group()]}
        canReact
        refetchKey={['comments', 'iss-1']}
      />
    );

    await screen.findByRole('button', { name: /Thumbs up/ });
    expect(listReactions).not.toHaveBeenCalled();
  });

  it('reads its own groups when none arrive inline, as on an issue', async () => {
    listReactions.mockResolvedValue([group({ emoji: '🎉', count: 1 })]);
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="iss-1"
        targetKind="issue"
        canReact
      />
    );

    await waitFor(() => {
      expect(listReactions).toHaveBeenCalled();
    });
    expect(
      await screen.findByRole('button', { name: /Celebrate/ })
    ).toBeInTheDocument();
  });

  it('hides the picker from someone who may only read', () => {
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="c-1"
        targetKind="comment"
        reactions={[group()]}
        canReact={false}
        refetchKey={['comments', 'iss-1']}
      />
    );

    expect(
      screen.queryByRole('button', { name: 'Add a reaction' })
    ).not.toBeInTheDocument();
  });

  it('leaves out a group nothing is left on', () => {
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="c-1"
        targetKind="comment"
        reactions={[group({ count: 0 })]}
        canReact
        refetchKey={['comments', 'iss-1']}
      />
    );

    expect(
      screen.queryByRole('button', { name: /Thumbs up/ })
    ).not.toBeInTheDocument();
  });

  it('marks a group the caller reacted to as pressed', () => {
    render(
      <ReactionBar
        workspaceId="ws-1"
        targetId="c-1"
        targetKind="comment"
        reactions={[group({ reacted: true })]}
        canReact
        refetchKey={['comments', 'iss-1']}
      />
    );

    expect(screen.getByRole('button', { name: /Thumbs up/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
