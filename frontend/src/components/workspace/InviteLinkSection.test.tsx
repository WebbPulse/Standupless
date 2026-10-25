/**
 * The invite link section. It offers to enable the link when it is off, shows
 * a freshly minted link once, asks before a reset because the old link stops
 * working at once, and disables the link.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InviteLinkCreated,
  InviteLinkRead,
  WorkspaceRead,
} from '../../types/Api';
import InviteLinkSection from './InviteLinkSection';

const getInviteLink = vi.fn<() => Promise<InviteLinkRead>>();
const resetInviteLink = vi.fn<() => Promise<InviteLinkCreated>>();
const disableInviteLink = vi.fn<() => Promise<void>>();

vi.mock('../../api/workspaces', () => ({
  getInviteLink: () => getInviteLink(),
  resetInviteLink: () => resetInviteLink(),
  disableInviteLink: () => disableInviteLink(),
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

const WORKSPACE: WorkspaceRead = {
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  plan: 'free',
  created_at: '2026-10-01T00:00:00Z',
  role: 'admin',
};

const OFF: InviteLinkRead = {
  enabled: false,
  created_by: null,
  created_at: null,
};

const ON: InviteLinkRead = {
  enabled: true,
  created_by: 'user-1',
  created_at: '2026-10-20T00:00:00Z',
};

/** Mounts the section inside a router. */
const renderSection = () =>
  render(
    <MemoryRouter>
      <InviteLinkSection workspace={WORKSPACE} />
    </MemoryRouter>
  );

beforeEach(() => {
  getInviteLink.mockReset();
  resetInviteLink.mockReset();
  disableInviteLink.mockReset();
});

describe('InviteLinkSection', () => {
  it('enables the link and shows it once', async () => {
    getInviteLink.mockResolvedValueOnce(OFF);
    getInviteLink.mockResolvedValue(ON);
    resetInviteLink.mockResolvedValue({ ...ON, token: 'tok-new' });
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Enable invite link' })
    );
    expect(resetInviteLink).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/join\?token=tok-new/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/tok-new/)).not.toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Reset link' })
    ).toBeInTheDocument();
  });

  it('asks before resetting and can be cancelled', async () => {
    getInviteLink.mockResolvedValue(ON);
    resetInviteLink.mockResolvedValue({ ...ON, token: 'tok-rotated' });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Reset link' }));
    expect(
      screen.getByText('The current link stops working at once.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(resetInviteLink).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reset link' }));
    await user.click(screen.getByRole('button', { name: 'Reset link' }));
    expect(resetInviteLink).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/join\?token=tok-rotated/)
    ).toBeInTheDocument();
  });

  it('disables the link', async () => {
    getInviteLink.mockResolvedValueOnce(ON);
    getInviteLink.mockResolvedValue(OFF);
    disableInviteLink.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Disable link' })
    );
    expect(disableInviteLink).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole('button', { name: 'Enable invite link' })
    ).toBeInTheDocument();
  });
});
