/**
 * The team notifications section. A team admin lists, adds and tests the
 * team's Slack and Discord channels; the stored URL is never shown, only its
 * masked hint; a channel turned off because its webhook is gone carries a
 * re-enable action; and anyone else sees a note without a request being made.
 * The Slack and Discord connections show read only with a link to the
 * workspace integrations page, and once one is installed a new channel
 * defaults to a channel picked by name from a filterable list.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelRead,
  ChannelTestRead,
  DiscordChannelRead,
  DiscordConnectionRead,
  InstallUrlRead,
  SlackChannelRead,
  SlackConnectionRead,
} from '../../types/Api';
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

const getSlackConnection =
  vi.fn<(workspaceId: string) => Promise<SlackConnectionRead>>();
const getSlackInstallUrl =
  vi.fn<(workspaceId: string, teamId?: string) => Promise<InstallUrlRead>>();
const deleteSlackConnection = vi.fn<(workspaceId: string) => Promise<void>>();
const listSlackChannels =
  vi.fn<(workspaceId: string, teamId: string) => Promise<SlackChannelRead[]>>();
const getDiscordConnection =
  vi.fn<(workspaceId: string) => Promise<DiscordConnectionRead>>();
const getDiscordInstallUrl =
  vi.fn<(workspaceId: string, teamId?: string) => Promise<InstallUrlRead>>();
const deleteDiscordConnection = vi.fn<(workspaceId: string) => Promise<void>>();
const listDiscordChannels =
  vi.fn<
    (workspaceId: string, teamId: string) => Promise<DiscordChannelRead[]>
  >();
const assign = vi.fn();

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
    getSlackConnection: (workspaceId: string) =>
      getSlackConnection(workspaceId),
    getSlackInstallUrl: (workspaceId: string, teamId?: string) =>
      getSlackInstallUrl(workspaceId, teamId),
    deleteSlackConnection: (workspaceId: string) =>
      deleteSlackConnection(workspaceId),
    listSlackChannels: (workspaceId: string, teamId: string) =>
      listSlackChannels(workspaceId, teamId),
    getDiscordConnection: (workspaceId: string) =>
      getDiscordConnection(workspaceId),
    getDiscordInstallUrl: (workspaceId: string, teamId?: string) =>
      getDiscordInstallUrl(workspaceId, teamId),
    deleteDiscordConnection: (workspaceId: string) =>
      deleteDiscordConnection(workspaceId),
    listDiscordChannels: (workspaceId: string, teamId: string) =>
      listDiscordChannels(workspaceId, teamId),
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

/** A Slack connection in the shape the contract answers with. */
const installedSlack: SlackConnectionRead = {
  configured: true,
  installed: true,
  slack_team_id: 'T0123',
  slack_team_name: 'Acme',
  installed_by: 'user-1',
  installed_at: '2026-10-09T00:00:00Z',
};

/** A Discord connection in the shape the contract answers with. */
const installedDiscord: DiscordConnectionRead = {
  configured: true,
  installed: true,
  guild_id: '1000000000000000002',
  guild_name: 'Acme Discord',
  installed_by: 'user-1',
  installed_at: '2026-10-09T00:00:00Z',
};

beforeEach(() => {
  getDiscordConnection.mockReset();
  getDiscordInstallUrl.mockReset();
  deleteDiscordConnection.mockReset();
  listDiscordChannels.mockReset();
  getDiscordConnection.mockResolvedValue({
    configured: false,
    installed: false,
  });
  listDiscordChannels.mockResolvedValue([]);
  getSlackConnection.mockReset();
  getSlackInstallUrl.mockReset();
  deleteSlackConnection.mockReset();
  listSlackChannels.mockReset();
  assign.mockReset();
  getSlackConnection.mockResolvedValue({
    configured: false,
    installed: false,
  });
  listSlackChannels.mockResolvedValue([]);
  vi.stubGlobal('location', { assign });
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

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('holds the list place with a skeleton while the first read is in flight', async () => {
    listChannels.mockReturnValue(new Promise(() => undefined));
    render(
      <TeamChannelsSection workspaceId="ws-loading" teamId="team-1" canEdit />
    );

    expect(
      await screen.findByRole('status', { name: 'Loading channels' })
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading channels')).toBeNull();
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

  it('shows a new channel at once even when the list read after it is stale', async () => {
    listChannels.mockResolvedValue([]);
    createChannel.mockResolvedValue({
      ...channel,
      channel_id: 'ch-new',
      label: 'Alerts',
    });
    render(
      <TeamChannelsSection workspaceId="ws-stale" teamId="team-1" canEdit />
    );

    expect(await screen.findByText('No channels yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    await userEvent.type(
      screen.getByLabelText('Webhook URL'),
      'https://discord.com/api/webhooks/1/abc'
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Add channel',
      })
    );

    expect(await screen.findByText('Alerts')).toBeInTheDocument();
    expect(screen.queryByText('No channels yet.')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
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

  it('sends a test message from the row and says whether it landed', async () => {
    testChannel.mockResolvedValue({
      delivered: false,
      status_code: 404,
      error: 'no_service',
    });
    render(<TeamChannelsSection workspaceId="ws-1" teamId="team-1" canEdit />);

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Send a test message to #eng',
      })
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
    render(
      <TeamChannelsSection workspaceId="ws-disabled" teamId="team-1" canEdit />
    );

    expect(
      await screen.findByText('Turned off automatically')
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Re-enable' }));

    await waitFor(() => {
      expect(updateChannel).toHaveBeenCalledWith(
        'ws-disabled',
        'team-1',
        'ch-1',
        { enabled: true }
      );
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

describe('the chat app connections in team settings', () => {
  it('shows no Slack row when this environment has no Slack App', async () => {
    render(
      <TeamChannelsSection
        workspaceId="ws-1"
        teamId="team-1"
        canEdit
        canManageWorkspace
      />
    );

    expect(await screen.findByText('#eng')).toBeInTheDocument();
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
  });

  it('links a workspace admin to the integrations page instead of installing here', async () => {
    getSlackConnection.mockResolvedValue({
      configured: true,
      installed: false,
    });
    render(
      <MemoryRouter>
        <TeamChannelsSection
          workspaceId="ws-slack-add"
          teamId="team-1"
          canEdit
          canManageWorkspace
          workspaceSlug="acme"
        />
      </MemoryRouter>
    );

    const link = await screen.findByRole('link', {
      name: 'Connect Slack in workspace settings',
    });
    expect(link).toHaveAttribute('href', '/w/acme/settings/integrations');
    expect(
      screen.queryByRole('button', { name: 'Connect Slack' })
    ).not.toBeInTheDocument();
    expect(getSlackInstallUrl).not.toHaveBeenCalled();
  });

  it('tells a team admin who is not a workspace admin who can connect', async () => {
    getSlackConnection.mockResolvedValue({
      configured: true,
      installed: false,
    });
    render(
      <TeamChannelsSection
        workspaceId="ws-slack-member"
        teamId="team-1"
        canEdit
        workspaceSlug="acme"
      />
    );

    expect(
      await screen.findByText(
        'A workspace admin can connect Slack in workspace settings.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('names the connected Slack workspace read only, with no disconnect', async () => {
    getSlackConnection.mockResolvedValue(installedSlack);
    render(
      <MemoryRouter>
        <TeamChannelsSection
          workspaceId="ws-slack-readonly"
          teamId="team-1"
          canEdit
          canManageWorkspace
          workspaceSlug="acme"
        />
      </MemoryRouter>
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Manage in workspace settings' })
    ).toHaveAttribute('href', '/w/acme/settings/integrations');
    expect(
      screen.queryByRole('button', { name: 'Disconnect' })
    ).not.toBeInTheDocument();
  });

  it('adds a Slack channel picked from the list by mouse once the App is installed', async () => {
    getSlackConnection.mockResolvedValue(installedSlack);
    listSlackChannels.mockResolvedValue([
      { id: 'C0123', name: 'eng-updates', is_private: false },
      { id: 'C0456', name: 'leads', is_private: true },
    ]);
    render(
      <TeamChannelsSection
        workspaceId="ws-slack-pick"
        teamId="team-1"
        canEdit
      />
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('radio', { name: 'Slack app' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).queryByLabelText('Webhook URL')).toBeNull();
    await userEvent.click(
      await within(dialog).findByRole('button', {
        name: 'Slack channel: none',
      })
    );
    expect(
      await within(dialog).findByRole('option', { name: /#leads/ })
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('option', { name: /#eng-updates/ })
    );
    expect(
      within(dialog).getByRole('button', {
        name: 'Slack channel: #eng-updates',
      })
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Label')).toHaveAttribute(
      'placeholder',
      'Defaults to #eng-updates'
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add channel' })
    );

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith('ws-slack-pick', 'team-1', {
        slack_channel_id: 'C0123',
        slack_channel_name: 'eng-updates',
        label: '',
        events: [
          'issue_created',
          'issue_status_changed',
          'issue_completed',
          'issue_assigned',
          'comment_created',
          'project_update_posted',
          'project_update_due',
        ],
      });
    });
    expect(listSlackChannels).toHaveBeenCalledWith('ws-slack-pick', 'team-1');
  });

  it('picks a Slack channel by keyboard', async () => {
    getSlackConnection.mockResolvedValue(installedSlack);
    listSlackChannels.mockResolvedValue([
      { id: 'C0123', name: 'eng-updates', is_private: false },
      { id: 'C0456', name: 'leads', is_private: true },
    ]);
    render(
      <TeamChannelsSection
        workspaceId="ws-slack-keys"
        teamId="team-1"
        canEdit
      />
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(
      await within(dialog).findByRole('button', {
        name: 'Slack channel: none',
      })
    );
    await within(dialog).findByRole('option', { name: /#leads/ });
    await userEvent.keyboard('leads');
    await userEvent.keyboard('{Enter}');

    expect(
      await within(dialog).findByRole('button', {
        name: 'Slack channel: #leads',
      })
    ).toBeInTheDocument();
  });

  it('still adds an incoming webhook when one is chosen over the App', async () => {
    getSlackConnection.mockResolvedValue(installedSlack);
    render(
      <TeamChannelsSection
        workspaceId="ws-slack-webhook"
        teamId="team-1"
        canEdit
      />
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    await userEvent.click(
      screen.getByRole('radio', { name: 'Incoming webhook' })
    );
    await userEvent.type(
      screen.getByLabelText('Webhook URL'),
      'https://discord.com/api/webhooks/1/abc'
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Add channel',
      })
    );

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith(
        'ws-slack-webhook',
        'team-1',
        expect.objectContaining({
          url: 'https://discord.com/api/webhooks/1/abc',
        })
      );
    });
    expect(createChannel.mock.calls[0]?.[2]).not.toHaveProperty(
      'slack_channel_id'
    );
  });

  it('shows a channel the bot posts to by its Slack name, without a URL to edit', async () => {
    listChannels.mockResolvedValue([
      {
        ...channel,
        label: '',
        transport: 'slack_app',
        slack_channel_id: 'C0123',
        url_hint: '#eng-updates',
      },
    ]);
    render(
      <TeamChannelsSection workspaceId="ws-slack-row" teamId="team-1" canEdit />
    );

    expect(await screen.findAllByText('#eng-updates')).not.toHaveLength(0);
    expect(screen.getByText('Slack app')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: '#eng-updates actions' })
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.queryByLabelText('Webhook URL')).toBeNull();
  });

  it('names the connected Discord server read only', async () => {
    getDiscordConnection.mockResolvedValue(installedDiscord);
    render(
      <TeamChannelsSection
        workspaceId="ws-discord-readonly"
        teamId="team-1"
        workspaceSlug="engineering"
        canEdit
      />
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Acme Discord')).toBeInTheDocument();
    expect(
      screen.getByText('A workspace admin manages this connection.')
    ).toBeInTheDocument();
  });

  it('adds a Discord channel picked by name once the App is installed', async () => {
    getDiscordConnection.mockResolvedValue(installedDiscord);
    listDiscordChannels.mockResolvedValue([
      { id: '2000000000000000001', name: 'eng-updates' },
      { id: '2000000000000000002', name: 'news' },
    ]);
    render(
      <TeamChannelsSection
        workspaceId="ws-discord-pick"
        teamId="team-1"
        canEdit
      />
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('radio', { name: 'Discord app' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).queryByLabelText('Webhook URL')).toBeNull();
    await userEvent.click(
      await within(dialog).findByRole('button', {
        name: 'Discord channel: none',
      })
    );
    await userEvent.click(
      await within(dialog).findByRole('option', { name: /#eng-updates/ })
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add channel' })
    );

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith(
        'ws-discord-pick',
        'team-1',
        expect.objectContaining({
          discord_channel_id: '2000000000000000001',
          discord_channel_name: 'eng-updates',
        })
      );
    });
    expect(createChannel.mock.calls[0]?.[2]).not.toHaveProperty('url');
    expect(listDiscordChannels).toHaveBeenCalledWith(
      'ws-discord-pick',
      'team-1'
    );
  });

  it('labels a channel the Discord bot posts to by its App', async () => {
    listChannels.mockResolvedValue([
      {
        ...channel,
        label: '',
        transport: 'discord_app',
        discord_channel_id: '2000000000000000001',
        url_hint: '#eng-updates',
      },
    ]);
    render(
      <TeamChannelsSection
        workspaceId="ws-discord-row"
        teamId="team-1"
        canEdit
      />
    );

    expect(await screen.findAllByText('#eng-updates')).not.toHaveLength(0);
    expect(screen.getByText('Discord app')).toBeInTheDocument();
  });
});
