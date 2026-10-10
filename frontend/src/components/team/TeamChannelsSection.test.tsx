/**
 * The team notifications section. A team admin lists, adds and tests the
 * team's Slack and Discord channels; the stored URL is never shown, only its
 * masked hint; a channel turned off because its webhook is gone carries a
 * re-enable action; and anyone else sees a note without a request being made.
 * With the Slack App offered, a workspace admin adds or removes it from a row
 * above the list, and once it is installed a new channel defaults to a Slack
 * channel picked by name. The Discord App works the same way.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('the Slack app connection', () => {
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
    expect(screen.queryByText('Slack app')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add to Slack' })
    ).not.toBeInTheDocument();
  });

  it('sends a workspace admin to Slack with the team to return to', async () => {
    getSlackConnection.mockResolvedValue({
      configured: true,
      installed: false,
    });
    getSlackInstallUrl.mockResolvedValue({
      url: 'https://slack.com/oauth/v2/authorize?state=s',
      expires_at: '2026-10-09T00:10:00Z',
    });
    render(
      <TeamChannelsSection
        workspaceId="ws-slack-add"
        teamId="team-1"
        canEdit
        canManageWorkspace
      />
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Add to Slack' })
    );

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        'https://slack.com/oauth/v2/authorize?state=s'
      );
    });
    expect(getSlackInstallUrl).toHaveBeenCalledWith('ws-slack-add', 'team-1');
  });

  it('offers a team admin who is not a workspace admin no install', async () => {
    getSlackConnection.mockResolvedValue({
      configured: true,
      installed: false,
    });
    render(
      <TeamChannelsSection
        workspaceId="ws-slack-member"
        teamId="team-1"
        canEdit
      />
    );

    expect(
      await screen.findByText(
        'A workspace admin can add the Slack app to pick channels by name.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add to Slack' })
    ).not.toBeInTheDocument();
  });

  it('names the Slack workspace and disconnects after a confirm', async () => {
    getSlackConnection.mockResolvedValue(installedSlack);
    deleteSlackConnection.mockResolvedValue();
    render(
      <TeamChannelsSection
        workspaceId="ws-slack-remove"
        teamId="team-1"
        canEdit
        canManageWorkspace
      />
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Posts as a bot in Acme/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(deleteSlackConnection).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Disconnect Slack',
      })
    );

    await waitFor(() => {
      expect(deleteSlackConnection).toHaveBeenCalledWith('ws-slack-remove');
    });
  });

  it('adds a Slack channel picked by name once the App is installed', async () => {
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
    await within(dialog).findByRole('option', { name: '#leads (private)' });
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Slack channel'),
      'C0123'
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

  it('sends a workspace admin to Discord with the team to return to', async () => {
    getDiscordConnection.mockResolvedValue({
      configured: true,
      installed: false,
    });
    getDiscordInstallUrl.mockResolvedValue({
      url: 'https://discord.com/oauth2/authorize?state=s',
      expires_at: '2026-10-09T00:10:00Z',
    });
    render(
      <TeamChannelsSection
        workspaceId="ws-discord-add"
        teamId="team-1"
        canEdit
        canManageWorkspace
      />
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Add to Discord' })
    );

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        'https://discord.com/oauth2/authorize?state=s'
      );
    });
    expect(getDiscordInstallUrl).toHaveBeenCalledWith(
      'ws-discord-add',
      'team-1'
    );
    expect(
      screen.queryByRole('button', { name: 'Add to Slack' })
    ).not.toBeInTheDocument();
  });

  it('names the Discord server and disconnects after a confirm', async () => {
    getDiscordConnection.mockResolvedValue(installedDiscord);
    deleteDiscordConnection.mockResolvedValue();
    render(
      <TeamChannelsSection
        workspaceId="ws-discord-remove"
        teamId="team-1"
        canEdit
        canManageWorkspace
      />
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(
      screen.getByText(/Posts as a bot in Acme Discord/)
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Disconnect Discord',
      })
    );

    await waitFor(() => {
      expect(deleteDiscordConnection).toHaveBeenCalledWith('ws-discord-remove');
    });
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
    await within(dialog).findByRole('option', { name: '#news' });
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Discord channel'),
      '2000000000000000001'
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
