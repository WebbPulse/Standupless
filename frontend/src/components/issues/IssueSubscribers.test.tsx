/**
 * The issue's subscription controls: the Subscribers rail section, the bell in
 * the issue bar, the shortcut and the command palette entry, all driven by one
 * useIssueSubscription read. Covers that the section lists who follows the
 * issue with why, that each toggle calls the verb matching the caller's state,
 * and that an issue nobody follows still offers a way to subscribe, which is
 * the case that once left no visible control at all.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useIssueSubscription,
  type IssueSubscription,
} from '../../hooks/useIssueSubscription';
import { useRegisteredShortcuts } from '../../hooks/useShortcuts';
import type { SubscribersRead } from '../../types/Api';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import IssueSubscribeButton from './IssueSubscribeButton';
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

/** A subscriber list with one follower, in the contract's shape. */
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

/** The answer for an issue nobody follows. */
const nobody: SubscribersRead = { subscribed: false, subscribers: [] };

/** Lists the issue-scope shortcut labels, as the command palette reads them. */
const PaletteProbe: React.FC = () => {
  const registered = useRegisteredShortcuts();
  return (
    <ul aria-label="Palette issue actions">
      {registered
        .filter((shortcut) => shortcut.scope === 'issue')
        .map((shortcut) => (
          <li key={shortcut.id}>{shortcut.label}</li>
        ))}
    </ul>
  );
};

/** Reads the subscription once and hands it to both controls, like the view. */
const Harness: React.FC = () => {
  const subscription: IssueSubscription = useIssueSubscription('ws-1', 'iss-1');
  return (
    <>
      <header aria-label="Issue bar">
        <IssueSubscribeButton subscription={subscription} />
      </header>
      <aside aria-label="Rail">
        <IssueSubscribers subscription={subscription} />
      </aside>
      <PaletteProbe />
    </>
  );
};

/** Renders the harness inside the shortcut registry. */
const renderHarness = () => {
  const user = userEvent.setup();
  render(
    <ShortcutProvider>
      <Harness />
    </ShortcutProvider>
  );
  return user;
};

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
    renderHarness();

    expect(await screen.findByText('Olive Owner')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
  });

  it('subscribes a caller who is not following', async () => {
    listSubscribers.mockResolvedValue(answer(false));
    const user = renderHarness();

    await screen.findByText('Olive Owner');
    const rail = screen.getByRole('complementary', { name: 'Rail' });
    await user.click(
      within(rail).getByRole('button', { name: 'Subscribe to issue' })
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes a caller who is following', async () => {
    listSubscribers.mockResolvedValue(answer(true));
    const user = renderHarness();

    const buttons = await screen.findAllByRole('button', {
      name: 'Unsubscribe from issue',
    });
    await user.click(buttons[0]!);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('an issue nobody is subscribed to', () => {
  it('keeps the rail section and its toggle on screen', async () => {
    listSubscribers.mockResolvedValue(nobody);
    renderHarness();

    expect(
      await screen.findByText('Nobody is subscribed to this issue.')
    ).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Rail' });
    expect(
      within(rail).getByRole('button', { name: 'Subscribe to issue' })
    ).toBeEnabled();
  });

  it('subscribes from the bell in the issue bar, with the shortcut in its tooltip', async () => {
    listSubscribers.mockResolvedValueOnce(nobody);
    listSubscribers.mockResolvedValue({
      subscribed: true,
      subscribers: [{ ...answer(true).subscribers[0]!, reason: 'manual' }],
    });
    const user = renderHarness();

    await screen.findByText('Nobody is subscribed to this issue.');
    const bar = screen.getByRole('banner', { name: 'Issue bar' });
    const bell = within(bar).getByRole('button', {
      name: 'Subscribe to issue',
    });
    expect(bell).toBeEnabled();
    await user.hover(bell);
    expect(
      await screen.findByText(/^Subscribe to issue \(.+\)$/)
    ).toBeInTheDocument();

    await user.click(bell);

    expect(subscribe).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: 'Unsubscribe from issue' })
      ).toHaveLength(2);
    });
  });

  it('offers Subscribe to issue in the command palette', async () => {
    listSubscribers.mockResolvedValue(nobody);
    renderHarness();

    const palette = screen.getByRole('list', {
      name: 'Palette issue actions',
    });
    await waitFor(() => {
      expect(palette).toHaveTextContent('Subscribe to issue');
    });
  });

  it('subscribes from the keyboard shortcut', async () => {
    listSubscribers.mockResolvedValue(nobody);
    const user = renderHarness();

    await screen.findByText('Nobody is subscribed to this issue.');
    await user.keyboard('{Control>}{Shift>}s{/Shift}{/Control}');

    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(1);
    });
  });
});
