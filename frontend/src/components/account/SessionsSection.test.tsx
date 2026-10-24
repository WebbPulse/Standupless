/**
 * The sessions section: this session first with a browser and operating
 * system label on every row, and signing out of every other session behind a
 * confirm step.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import SessionsSection from './SessionsSection';

/** A browser session as the list reports it. */
const session = (overrides: Record<string, unknown>) => ({
  id: 'session',
  device: 'desktop',
  ip: '203.0.113.7',
  lastIp: '203.0.113.7',
  client: '',
  platform: 'macOS',
  browser: 'Chrome',
  clientId: '',
  startedAt: '2026-10-20T10:00:00Z',
  lastActiveAt: '2026-10-23T10:00:00Z',
  expiresAt: null,
  amr: ['pwd'],
  current: false,
  ...overrides,
});

const listSessions = vi.fn<() => Promise<unknown>>();
const revokeSession = vi.fn<(id: string) => Promise<unknown>>();
const revokeOtherSessions = vi.fn<() => Promise<unknown>>();

const fakeClient = {
  listSessions: () => listSessions(),
  revokeSession: (id: string) => revokeSession(id),
  revokeOtherSessions: () => revokeOtherSessions(),
};

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => fakeClient,
}));

vi.mock('../../api/connectedApps', () => ({
  listMyConnectedApps: () => Promise.resolve([]),
}));

const renderSection = () =>
  render(
    <MemoryRouter>
      <SessionsSection />
    </MemoryRouter>
  );

beforeEach(() => {
  listSessions.mockReset().mockResolvedValue({
    ok: true,
    sessions: [
      session({
        id: 'phone',
        platform: 'iOS',
        browser: 'Safari',
        device: 'mobile',
      }),
      session({ id: 'here', current: true }),
      session({ id: 'laptop', platform: 'Windows', browser: 'Firefox' }),
    ],
  });
  revokeSession.mockReset().mockResolvedValue({ ok: true });
  revokeOtherSessions.mockReset().mockResolvedValue({ ok: true, revoked: 2 });
  clearToasts();
});

describe('SessionsSection', () => {
  it('lists this session first and names each browser and platform', async () => {
    renderSection();
    const rows = await screen.findAllByTestId('session-row');
    expect(rows).toHaveLength(3);
    const [here, phone, laptop] = rows as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(within(here).getByText('Chrome on macOS')).toBeInTheDocument();
    expect(within(here).getByText('This session')).toBeInTheDocument();
    expect(within(phone).getByText('Safari on iOS')).toBeInTheDocument();
    expect(within(laptop).getByText('Firefox on Windows')).toBeInTheDocument();
  });

  it('signs out of every other session after the confirm step', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByTestId('session-row');

    await user.click(
      screen.getByRole('button', { name: 'Sign out of all other sessions' })
    );
    const dialog = await screen.findByRole('dialog');
    expect(revokeOtherSessions).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText(/signs out the 2 other devices/)
    ).toBeInTheDocument();

    listSessions.mockResolvedValue({
      ok: true,
      sessions: [session({ id: 'here', current: true })],
    });
    await user.click(
      within(dialog).getByRole('button', { name: 'Sign out other sessions' })
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('session-row')).toHaveLength(1);
    });
    expect(revokeOtherSessions).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Sign out of all other sessions' })
    ).not.toBeInTheDocument();
    expect(currentToasts().map((toast) => toast.message)).toContain(
      'Signed out of 2 other sessions.'
    );
  });

  it('keeps every session when the confirm step is cancelled', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByTestId('session-row');

    await user.click(
      screen.getByRole('button', { name: 'Sign out of all other sessions' })
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Cancel',
      })
    );

    expect(revokeOtherSessions).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('session-row')).toHaveLength(3);
  });

  it('hides the action when this is the only session', async () => {
    listSessions.mockResolvedValue({
      ok: true,
      sessions: [session({ id: 'here', current: true })],
    });
    renderSection();
    await screen.findAllByTestId('session-row');
    expect(
      screen.queryByRole('button', { name: 'Sign out of all other sessions' })
    ).not.toBeInTheDocument();
  });
});
