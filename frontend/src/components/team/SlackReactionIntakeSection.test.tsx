/**
 * The Slack emoji reaction intake section. It hides where the environment has
 * no Slack App, points at workspace settings until Slack is connected, lets a
 * team admin pick an emoji and channels and turn it on or off, and shows anyone
 * else a read only summary without asking for the bot's channel list.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SlackChannelRead,
  SlackIntakeRead,
  SlackIntakeWrite,
} from '../../types/Api';
import SlackReactionIntakeSection, {
  normalizeEmoji,
  validEmoji,
} from './SlackReactionIntakeSection';

const getSlackIntake =
  vi.fn<(workspaceId: string, teamId: string) => Promise<SlackIntakeRead>>();
const saveSlackIntake =
  vi.fn<
    (
      workspaceId: string,
      teamId: string,
      body: SlackIntakeWrite
    ) => Promise<SlackIntakeRead>
  >();
const disableSlackIntake =
  vi.fn<(workspaceId: string, teamId: string) => Promise<void>>();
const listSlackChannels =
  vi.fn<(workspaceId: string, teamId: string) => Promise<SlackChannelRead[]>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    getSlackIntake: (workspaceId: string, teamId: string) =>
      getSlackIntake(workspaceId, teamId),
    saveSlackIntake: (
      workspaceId: string,
      teamId: string,
      body: SlackIntakeWrite
    ) => saveSlackIntake(workspaceId, teamId, body),
    disableSlackIntake: (workspaceId: string, teamId: string) =>
      disableSlackIntake(workspaceId, teamId),
    listSlackChannels: (workspaceId: string, teamId: string) =>
      listSlackChannels(workspaceId, teamId),
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

/** The setting before anyone turns it on, with Slack connected. */
const off: SlackIntakeRead = {
  configured: true,
  installed: true,
  enabled: false,
  reinstall: false,
  emoji: null,
  channel_ids: [],
  message_channel_ids: [],
  updated_at: null,
};

/** The setting once a team admin turned it on. */
const on: SlackIntakeRead = {
  ...off,
  enabled: true,
  emoji: 'ticket',
  channel_ids: ['C0001'],
  updated_at: '2026-10-25T00:00:00Z',
};

const channels: SlackChannelRead[] = [
  { id: 'C0001', name: 'support', is_private: false },
  { id: 'G0002', name: 'oncall', is_private: true },
];

beforeEach(() => {
  getSlackIntake.mockReset();
  saveSlackIntake.mockReset();
  disableSlackIntake.mockReset();
  listSlackChannels.mockReset();
  listSlackChannels.mockResolvedValue(channels);
  saveSlackIntake.mockResolvedValue(on);
  disableSlackIntake.mockResolvedValue(undefined);
});

describe('emoji names', () => {
  it('drops colons, case and a skin tone', () => {
    expect(normalizeEmoji(' :Ticket: ')).toBe('ticket');
    expect(normalizeEmoji('thumbsup::skin-tone-3')).toBe('thumbsup');
    expect(validEmoji('white_check_mark')).toBe(true);
    expect(validEmoji('two words')).toBe(false);
    expect(validEmoji('')).toBe(false);
  });
});

describe('the Slack reaction intake section', () => {
  it('renders nothing where the environment has no Slack App', async () => {
    getSlackIntake.mockResolvedValue({
      ...off,
      configured: false,
      installed: false,
    });
    const { container } = render(
      <SlackReactionIntakeSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    await waitFor(() => {
      expect(getSlackIntake).toHaveBeenCalledWith('ws-1', 'team-1');
    });
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('points at workspace settings until Slack is connected', async () => {
    getSlackIntake.mockResolvedValue({ ...off, installed: false });
    render(
      <SlackReactionIntakeSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    expect(
      await screen.findByText(/to file messages by emoji/)
    ).toBeInTheDocument();
    expect(listSlackChannels).not.toHaveBeenCalled();
  });

  it('lets a team admin pick an emoji and channels and turn it on', async () => {
    getSlackIntake.mockResolvedValue(off);
    const user = userEvent.setup();
    render(
      <SlackReactionIntakeSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    const turnOn = await screen.findByRole('button', { name: 'Turn on' });
    expect(turnOn).toBeDisabled();
    await user.click(await screen.findByLabelText('#support'));
    await user.click(screen.getByLabelText('#oncall (private)'));
    const emoji = screen.getByLabelText('Emoji');
    await user.clear(emoji);
    await user.type(emoji, ':Eyes:');
    await user.click(turnOn);

    await waitFor(() => {
      expect(saveSlackIntake).toHaveBeenCalledWith('ws-1', 'team-1', {
        emoji: 'eyes',
        channel_ids: ['C0001', 'G0002'],
        message_channel_ids: [],
      });
    });
  });

  it('sets a picked channel to file every new message', async () => {
    getSlackIntake.mockResolvedValue(off);
    const user = userEvent.setup();
    render(
      <SlackReactionIntakeSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    await user.click(await screen.findByLabelText('#support'));
    await user.click(screen.getByLabelText('#oncall (private)'));
    await user.selectOptions(
      screen.getByLabelText('Mode for #oncall'),
      'message'
    );
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    await waitFor(() => {
      expect(saveSlackIntake).toHaveBeenCalledWith('ws-1', 'team-1', {
        emoji: 'ticket',
        channel_ids: ['C0001', 'G0002'],
        message_channel_ids: ['G0002'],
      });
    });
  });

  it('turns intake off', async () => {
    getSlackIntake.mockResolvedValue(on);
    const user = userEvent.setup();
    render(
      <SlackReactionIntakeSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    await user.click(await screen.findByRole('button', { name: 'Turn off' }));

    await waitFor(() => {
      expect(disableSlackIntake).toHaveBeenCalledWith('ws-1', 'team-1');
    });
  });

  it('shows anyone else a summary without reading the channel list', async () => {
    getSlackIntake.mockResolvedValue(on);
    render(
      <SlackReactionIntakeSection
        workspaceId="ws-1"
        teamId="team-1"
        canEdit={false}
      />
    );

    expect(
      await screen.findByText(/Reacting with :ticket:/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(listSlackChannels).not.toHaveBeenCalled();
  });

  it('asks for a reconnect when the install predates reactions', async () => {
    getSlackIntake.mockResolvedValue({ ...on, reinstall: true });
    render(
      <SlackReactionIntakeSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    expect(
      await screen.findByText(/Slack was connected before reactions/)
    ).toBeInTheDocument();
  });
});
