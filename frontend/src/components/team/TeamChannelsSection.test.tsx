/**
 * The team notifications section. A team admin lists, adds and tests the
 * team's Slack and Discord channels; the stored URL is never shown, only its
 * masked hint; a channel turned off because its webhook is gone carries a
 * re-enable action; and anyone else sees a note without a request being made.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRead, ChannelTestRead } from '../../types/Api';
import TeamChannelsSection from './TeamChannelsSection';

const listChannels =
  vi.fn<(workspaceId: string, teamId: string) => Promise<ChannelRead[]>>();
const createChannel =
  vi.fn<
    (workspaceId: string, teamId: string, body: unknown) => Promise<ChannelRead>
  >();
const updateChannel =
  vi.fn<
    (
      workspaceId: string,
      teamId: string,
      channelId: string,
      body: unknown
    ) => Promise<ChannelRead>
  >();
const testChannel =
  vi.fn<
    (
      workspaceId: string,
      teamId: string,
      channelId: string
    ) => Promise<ChannelTestRead>
  >();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listChannels: (workspaceId: string, teamId: string) =>
      listChannels(workspaceId, teamId),
    createChannel: (workspaceId: string, teamId: string, body: unknown) =>
      createChannel(workspaceId, teamId, body),
    updateChannel: (
      workspaceId: string,
      teamId: string,
      channelId: string,
      body: unknown
    ) => updateChannel(workspaceId, teamId, channelId, body),
    testChannel: (workspaceId: string, teamId: string, channelId: string) =>
      testChannel(workspaceId, teamId, channelId),
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

/** One Slack channel in the shape the contract answers with. */
const channel: ChannelRead = {
  channel_id: 'ch-1',
  team_id: 'team-1',
  provider: 'slack',
  label: '#eng',
  events: ['issue_created', 'comment_created'],
  enabled: true,
  url_hint: 'hooks.slack.com/...ab12',
  last_status: null,
  last_delivery_at: null,
  disabled_reason: null,
  disabled_at: null,
  created_by: 'user-1',
  created_at: '2026-10-07T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z',
};

beforeEach(() => {
  listChannels.mockReset();
  createChannel.mockReset();
  updateChannel.mockReset();
  testChannel.mockReset();
  listChannels.mockResolvedValue([channel]);
  createChannel.mockResolvedValue(channel);
  updateChannel.mockResolvedValue(channel);
  testChannel.mockResolvedValue({
    delivered: true,
    status_code: 200,
    error: null,
  });
});

describe('the team notifications section', () => {
  it('lists the channels with their masked URL and events', async () => {
    render(<TeamChannelsSection workspaceId="ws-1" teamId="team-1" canEdit />);

    expect(await screen.findByText('#eng')).toBeInTheDocument();
    expect(listChannels).toHaveBeenCalledWith('ws-1', 'team-1');
    expect(screen.getByText('hooks.slack.com/...ab12')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('Issue created, New comment')).toBeInTheDocument();
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });

  it('adds a channel with the URL, label and chosen events', async () => {
    render(<TeamChannelsSection workspaceId="ws-1" teamId="team-1" canEdit />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Add channel' })
    );
    await userEvent.type(
      screen.getByLabelText('Webhook URL'),
      'https://discord.com/api/webhooks/1/abc'
    );
    await userEvent.type(screen.getByLabelText('Label'), 'Alerts');
    await userEvent.click(screen.getByLabelText('Project update due'));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Add channel',
      })
    );

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith('ws-1', 'team-1', {
        url: 'https://discord.com/api/webhooks/1/abc',
        label: 'Alerts',
        events: [
          'issue_created',
          'issue_status_changed',
          'issue_completed',
          'issue_assigned',
          'comment_created',
          'project_update_posted',
        ],
      });
    });
  });

  it('keeps the stored URL when an edit leaves the URL field empty', async () => {
    render(<TeamChannelsSection workspaceId="ws-1" teamId="team-1" canEdit />);

    await userEvent.click(
      await screen.findByRole('button', { name: '#eng actions' })
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByLabelText('Webhook URL')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Save channel' }));

    await waitFor(() => {
      expect(updateChannel).toHaveBeenCalledWith('ws-1', 'team-1', 'ch-1', {
        label: '#eng',
        events: ['issue_created', 'comment_created'],
      });
    });
  });

  it('sends a test message and says whether it landed', async () => {
    testChannel.mockResolvedValue({
      delivered: false,
      status_code: 404,
      error: 'no_service',
    });
    render(<TeamChannelsSection workspaceId="ws-1" teamId="team-1" canEdit />);

    await userEvent.click(
      await screen.findByRole('button', { name: '#eng actions' })
    );
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Send test message' })
    );

    expect(
      await screen.findByText(
        'Test message was not delivered (404): no_service'
      )
    ).toBeInTheDocument();
    expect(testChannel).toHaveBeenCalledWith('ws-1', 'team-1', 'ch-1');
  });

  it('offers to re-enable a channel that was turned off because its webhook is gone', async () => {
    listChannels.mockResolvedValue([
      {
        ...channel,
        enabled: false,
        disabled_reason:
          'The channel answered 404: the webhook was removed or the channel archived.',
        disabled_at: '2026-10-07T01:00:00Z',
      },
    ]);
    render(<TeamChannelsSection workspaceId="ws-1" teamId="team-1" canEdit />);

    expect(
      await screen.findByText('Turned off automatically')
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Re-enable' }));

    await waitFor(() => {
      expect(updateChannel).toHaveBeenCalledWith('ws-1', 'team-1', 'ch-1', {
        enabled: true,
      });
    });
  });

  it('shows a note and makes no request for someone who is not a team admin', () => {
    render(
      <TeamChannelsSection workspaceId="ws-1" teamId="team-1" canEdit={false} />
    );

    expect(
      screen.getByText(
        "Only a team admin can manage this team's Slack and Discord channels."
      )
    ).toBeInTheDocument();
    expect(listChannels).not.toHaveBeenCalled();
  });
});
