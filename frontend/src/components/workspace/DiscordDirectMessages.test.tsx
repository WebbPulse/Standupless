/**
 * The Discord direct message card: linking sends the browser to the consent
 * link the backend mints, unlinking clears the link, and a broken link names
 * its reason and offers to link again.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordLinkRead, DiscordLinkUrlRead } from '../../types/Api';
import DiscordDirectMessages from './DiscordDirectMessages';

const getDiscordLinkUrl =
  vi.fn<(workspaceId: string) => Promise<DiscordLinkUrlRead>>();
const unlinkDiscord = vi.fn<(workspaceId: string) => Promise<void>>();

vi.mock('../../api/integrations', () => ({
  getDiscordLinkUrl: (workspaceId: string) => getDiscordLinkUrl(workspaceId),
  unlinkDiscord: (workspaceId: string) => unlinkDiscord(workspaceId),
}));

const link = (fields: Partial<DiscordLinkRead> = {}): DiscordLinkRead => ({
  configured: true,
  available: true,
  linked: false,
  discord_user_id: null,
  guild_name: 'Acme Discord',
  linked_at: null,
  problem: null,
  ...fields,
});

beforeEach(() => {
  getDiscordLinkUrl.mockReset();
  unlinkDiscord.mockReset();
});

describe('DiscordDirectMessages', () => {
  it('sends the browser to the consent link', async () => {
    const navigate = vi.fn<(url: string) => void>();
    getDiscordLinkUrl.mockResolvedValue({
      url: 'https://discord.com/oauth2/authorize?scope=identify',
      expires_at: '2026-10-24T00:10:00Z',
    });
    render(
      <DiscordDirectMessages
        workspaceId="ws-1"
        link={link()}
        onChange={vi.fn()}
        navigate={navigate}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Link Discord' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        'https://discord.com/oauth2/authorize?scope=identify'
      );
    });
    expect(getDiscordLinkUrl).toHaveBeenCalledWith('ws-1');
  });

  it('unlinks and reports the cleared link', async () => {
    const onChange = vi.fn<(stored: DiscordLinkRead) => void>();
    unlinkDiscord.mockResolvedValue(undefined);
    render(
      <DiscordDirectMessages
        workspaceId="ws-1"
        link={link({ linked: true, discord_user_id: '1100000000000000002' })}
        onChange={onChange}
      />
    );
    expect(
      screen.queryByRole('button', { name: 'Link Discord' })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ linked: false, discord_user_id: null })
      );
    });
  });

  it('names why a broken link stopped and offers to link again', () => {
    render(
      <DiscordDirectMessages
        workspaceId="ws-1"
        link={link({ linked: true, problem: 'discord_50007' })}
        onChange={vi.fn()}
      />
    );
    expect(
      screen.getByText(/Allow direct messages from server members/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Link again' })
    ).toBeInTheDocument();
  });

  it('asks for an admin when the workspace has no Discord App', () => {
    render(
      <DiscordDirectMessages
        workspaceId="ws-1"
        link={link({ available: false })}
        onChange={vi.fn()}
      />
    );
    expect(
      screen.getByText(/A workspace admin connects Discord/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
