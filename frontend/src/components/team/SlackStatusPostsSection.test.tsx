/**
 * The Slack status posts switch. It hides where the environment has no Slack
 * App, shows on by default, lets a team admin turn it off and shows anyone else
 * a read only line. Private asks start off and a team admin turns them on.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SlackStatusPostsRead,
  SlackStatusPostsWrite,
} from '../../types/Api';
import SlackStatusPostsSection from './SlackStatusPostsSection';

const getSlackStatusPosts =
  vi.fn<
    (workspaceId: string, teamId: string) => Promise<SlackStatusPostsRead>
  >();
const saveSlackStatusPosts =
  vi.fn<
    (
      workspaceId: string,
      teamId: string,
      body: SlackStatusPostsWrite
    ) => Promise<SlackStatusPostsRead>
  >();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    getSlackStatusPosts: (workspaceId: string, teamId: string) =>
      getSlackStatusPosts(workspaceId, teamId),
    saveSlackStatusPosts: (
      workspaceId: string,
      teamId: string,
      body: SlackStatusPostsWrite
    ) => saveSlackStatusPosts(workspaceId, teamId, body),
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

/** The switch as a team starts out, with Slack connected. */
const on: SlackStatusPostsRead = {
  configured: true,
  installed: true,
  enabled: true,
  private_asks: false,
  updated_at: null,
};

beforeEach(() => {
  getSlackStatusPosts.mockReset();
  saveSlackStatusPosts.mockReset();
  saveSlackStatusPosts.mockResolvedValue({ ...on, enabled: false });
});

describe('the Slack status posts section', () => {
  it('renders nothing where the environment has no Slack App', async () => {
    getSlackStatusPosts.mockResolvedValue({
      ...on,
      configured: false,
      installed: false,
    });
    const { container } = render(
      <SlackStatusPostsSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    await waitFor(() => {
      expect(getSlackStatusPosts).toHaveBeenCalledWith('ws-1', 'team-1');
    });
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('is on by default and a team admin turns it off', async () => {
    getSlackStatusPosts.mockResolvedValueOnce(on);
    getSlackStatusPosts.mockResolvedValue({ ...on, enabled: false });
    render(
      <SlackStatusPostsSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    const box = await screen.findByRole('checkbox', {
      name: /Post status changes/,
    });
    expect(box).toBeChecked();
    await userEvent.click(box);

    await waitFor(() => {
      expect(saveSlackStatusPosts).toHaveBeenCalledWith('ws-1', 'team-1', {
        enabled: false,
      });
    });
  });

  it('keeps private asks off until a team admin turns them on', async () => {
    getSlackStatusPosts.mockResolvedValueOnce(on);
    getSlackStatusPosts.mockResolvedValue({ ...on, private_asks: true });
    render(
      <SlackStatusPostsSection workspaceId="ws-1" teamId="team-1" canEdit />
    );

    const box = await screen.findByRole('checkbox', {
      name: /Allow private asks/,
    });
    expect(box).not.toBeChecked();
    await userEvent.click(box);

    await waitFor(() => {
      expect(saveSlackStatusPosts).toHaveBeenCalledWith('ws-1', 'team-1', {
        private_asks: true,
      });
    });
  });

  it('shows a read only line to someone who cannot edit', async () => {
    getSlackStatusPosts.mockResolvedValue(on);
    render(
      <SlackStatusPostsSection
        workspaceId="ws-1"
        teamId="team-1"
        canEdit={false}
      />
    );

    expect(
      await screen.findByText(/Status changes are posted/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
