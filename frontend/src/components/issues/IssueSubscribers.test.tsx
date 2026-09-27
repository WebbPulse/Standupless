/**
 * The subscribers section of the issue rail. Covers that it lists who follows
 * the issue with why, and that the toggle calls the verb matching the caller's
 * current state, since a toggle that always subscribed would look right until
 * someone tried to leave.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscribersRead } from '../../types/Api';
import IssueSubscribers from './IssueSubscribers';

const listSubscribers = vi.fn<() => Promise<SubscribersRead>>();
const subscribe = vi.fn<() => Promise<SubscribersRead>>();
const unsubscribe = vi.fn<() => Promise<SubscribersRead>>();

vi.mock('../../api/notifications', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/notifications')
  >('../../api/notifications');
  return {
    ...actual,
    listSubscribers: () => listSubscribers(),
    subscribe: () => subscribe(),
    unsubscribe: () => unsubscribe(),
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

/** A subscriber list in the shape the contract answers with. */
const answer = (subscribed: boolean): SubscribersRead => ({
  subscribed,
  subscribers: [
    {
      user_id: 'u-1',
      display_name: 'Olive Owner',
      reason: 'creator',
      created_at: '2026-09-26T00:00:00Z',
    },
  ],
});

beforeEach(() => {
  listSubscribers.mockReset();
  subscribe.mockReset();
  unsubscribe.mockReset();
  subscribe.mockResolvedValue(answer(true));
  unsubscribe.mockResolvedValue(answer(false));
});

describe('the issue subscribers', () => {
  it('lists each subscriber with the reason they follow the issue', async () => {
    listSubscribers.mockResolvedValue(answer(false));
    render(<IssueSubscribers workspaceId="ws-1" issueId="iss-1" />);

    expect(await screen.findByText('Olive Owner')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
  });

  it('subscribes a caller who is not following', async () => {
    const user = userEvent.setup();
    listSubscribers.mockResolvedValue(answer(false));
    render(<IssueSubscribers workspaceId="ws-1" issueId="iss-1" />);

    await user.click(
      await screen.findByRole('button', { name: 'Subscribe to issue' })
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes a caller who is following', async () => {
    const user = userEvent.setup();
    listSubscribers.mockResolvedValue(answer(true));
    render(<IssueSubscribers workspaceId="ws-1" issueId="iss-1" />);

    await user.click(
      await screen.findByRole('button', { name: 'Unsubscribe from issue' })
    );

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
  });
});
