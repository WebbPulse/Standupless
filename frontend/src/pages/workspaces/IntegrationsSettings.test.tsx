/**
 * The workspace integrations page. A workspace admin connects Slack and
 * Discord here for every team, returning to this page, sees which Slack
 * workspace or Discord server is connected, by whom and when, disconnects
 * behind a confirm, and manages the workspace channels that follow every open
 * team or a chosen few. Anyone below admin is told they cannot.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ChannelRead,
  ChannelTestRead,
  DiscordConnectionRead,
  InstallUrlRead,
  MemberRead,
  SlackChannelRead,
  SlackConnectionRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import IntegrationsSettings from './IntegrationsSettings';

const listChannels =
  vi.fn<
    (workspaceId: string, teamId: string | null) => Promise<ChannelRead[]>
  >();
const createChannel =
  vi.fn<
    (
      workspaceId: string,
      teamId: string | null,
      body: unknown
    ) => Promise<ChannelRead>
  >();
const updateChannel =
  vi.fn<
    (
      workspaceId: string,
      teamId: string | null,
      channelId: string,
      body: unknown
    ) => Promise<ChannelRead>
  >();
const testChannel =
  vi.fn<
    (
      workspaceId: string,
      teamId: string | null,
      channelId: string
    ) => Promise<ChannelTestRead>
  >();
const getSlackConnection =
  vi.fn<(workspaceId: string) => Promise<SlackConnectionRead>>();
const getSlackInstallUrl =
  vi.fn<(workspaceId: string, teamId?: string) => Promise<InstallUrlRead>>();
const deleteSlackConnection = vi.fn<(workspaceId: string) => Promise<void>>();
const listSlackChannels =
  vi.fn<
    (workspaceId: string, teamId: string | null) => Promise<SlackChannelRead[]>
  >();
const getDiscordConnection =
  vi.fn<(workspaceId: string) => Promise<DiscordConnectionRead>>();
const getDiscordInstallUrl =
  vi.fn<(workspaceId: string, teamId?: string) => Promise<InstallUrlRead>>();
const assign = vi.fn();
const updateWorkspace =
  vi.fn<(workspaceId: string, body: unknown) => Promise<WorkspaceRead>>();

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return {
    ...actual,
    updateWorkspace: (workspaceId: string, body: unknown) =>
      updateWorkspace(workspaceId, body),
  };
});

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listChannels: (workspaceId: string, teamId: string | null) =>
      listChannels(workspaceId, teamId),
    createChannel: (
      workspaceId: string,
      teamId: string | null,
      body: unknown
    ) => createChannel(workspaceId, teamId, body),
    updateChannel: (
      workspaceId: string,
      teamId: string | null,
      channelId: string,
      body: unknown
    ) => updateChannel(workspaceId, teamId, channelId, body),
    testChannel: (
      workspaceId: string,
      teamId: string | null,
      channelId: string
    ) => testChannel(workspaceId, teamId, channelId),
    getSlackConnection: (workspaceId: string) =>
      getSlackConnection(workspaceId),
    getSlackInstallUrl: (workspaceId: string, teamId?: string) =>
      getSlackInstallUrl(workspaceId, teamId),
    deleteSlackConnection: (workspaceId: string) =>
      deleteSlackConnection(workspaceId),
    listSlackChannels: (workspaceId: string, teamId: string | null) =>
      listSlackChannels(workspaceId, teamId),
    getDiscordConnection: (workspaceId: string) =>
      getDiscordConnection(workspaceId),
    getDiscordInstallUrl: (workspaceId: string, teamId?: string) =>
      getDiscordInstallUrl(workspaceId, teamId),
    listGitlabConnections: () =>
      Promise.resolve({ configured: false, connections: [] }),
  };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
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

/** Two teams the workspace channel can follow. */
const teams: TeamRead[] = [
  {
    id: 'team-1',
    workspace_id: 'ws-1',
    name: 'Engine',
    key_prefix: 'ENG',
    description: null,
    estimate_scale: 'off',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
  },
  {
    id: 'team-2',
    workspace_id: 'ws-1',
    name: 'Design',
    key_prefix: 'DES',
    description: null,
    estimate_scale: 'off',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
  },
];

/** The member who installed the Apps. */
const installer: MemberRead = {
  user_id: 'user-1',
  email: 'owner@example.test',
  display_name: 'Avery Owner',
  role: 'owner',
  joined_at: '2026-09-17T00:00:00Z',
};

vi.mock('../../hooks/useTeams', () => ({
  useTeams: () => ({ data: teams, isLoading: false, error: null }),
}));

vi.mock('../../components/workspace/WorkspaceShell', () => ({
  default: ({
    title,
    toolbar,
    children,
  }: {
    title?: ReactNode;
    toolbar?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {toolbar}
      {children}
    </main>
  ),
}));

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => [installer],
}));

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole, id = 'ws-1'): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id,
    name: 'Engineering',
    slug: 'engineering',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** A workspace channel the Slack bot posts to, following every open team. */
const workspaceChannel: ChannelRead = {
  channel_id: 'ch-ws',
  team_id: '',
  scope: 'workspace',
  team_ids: [],
  provider: 'slack',
  transport: 'slack_app',
  slack_channel_id: 'C0999',
  label: '',
  events: ['issue_created'],
  enabled: true,
  url_hint: '#leadership',
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

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <IntegrationsSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  for (const mock of [
    listChannels,
    createChannel,
    updateChannel,
    testChannel,
    getSlackConnection,
    getSlackInstallUrl,
    deleteSlackConnection,
    listSlackChannels,
    getDiscordConnection,
    getDiscordInstallUrl,
    assign,
    updateWorkspace,
  ]) {
    mock.mockReset();
  }
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
  listChannels.mockResolvedValue([]);
  getSlackConnection.mockResolvedValue({ configured: true, installed: false });
  getDiscordConnection.mockResolvedValue({
    configured: false,
    installed: false,
  });
  listSlackChannels.mockResolvedValue([
    { id: 'C0999', name: 'leadership', is_private: false },
  ]);
  testChannel.mockResolvedValue({
    delivered: true,
    status_code: 200,
    error: null,
  });
  vi.stubGlobal('location', { ...window.location, assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the workspace integrations page', () => {
  it('tells someone below admin they cannot manage integrations', () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(
      screen.getByText(
        'Only workspace owners and admins can manage integrations.'
      )
    ).toBeInTheDocument();
    expect(getSlackConnection).not.toHaveBeenCalled();
    expect(listChannels).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Branch format')).not.toBeInTheDocument();
  });

  it('previews the branch format and saves the one an admin picks', async () => {
    const context = resolved('admin');
    useWorkspaceMock.mockReturnValue(context);
    updateWorkspace.mockResolvedValue(context.workspace as WorkspaceRead);
    renderPage();

    const select = await screen.findByLabelText('Branch format');
    expect(select).toHaveValue('key_title');
    expect(screen.getByTestId('branch-format-preview')).toHaveTextContent(
      'eng-123-fix-the-login-redirect'
    );

    await userEvent.selectOptions(select, 'user_key_title');

    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
        branch_format: 'user_key_title',
      });
    });
    expect(context.refresh).toHaveBeenCalled();
  });

  it('shows each saved format in the preview', async () => {
    const context = resolved('admin');
    useWorkspaceMock.mockReturnValue({
      ...context,
      workspace: {
        ...(context.workspace as WorkspaceRead),
        branch_format: 'user_key_title',
      },
    });
    const { unmount } = renderPage();

    expect(
      await screen.findByTestId('branch-format-preview')
    ).toHaveTextContent('username/eng-123-fix-the-login-redirect');
    unmount();

    useWorkspaceMock.mockReturnValue({
      ...context,
      workspace: {
        ...(context.workspace as WorkspaceRead),
        branch_format: 'key',
      },
    });
    renderPage();
    expect(
      await screen.findByTestId('branch-format-preview')
    ).toHaveTextContent(/^eng-123$/);
  });

  it('connects Slack for the whole workspace, returning to this page', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin', 'ws-connect'));
    getSlackInstallUrl.mockResolvedValue({
      url: 'https://slack.com/oauth/v2/authorize?state=s',
      expires_at: '2026-10-09T00:10:00Z',
    });
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect Slack' })
    );

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        'https://slack.com/oauth/v2/authorize?state=s'
      );
    });
    expect(getSlackInstallUrl).toHaveBeenCalledWith('ws-connect', undefined);
  });

  it('keeps Add channel off for the workspace until an App is connected', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin', 'ws-blocked'));
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Connect Slack' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add channel' })).toBeDisabled();
    expect(listChannels).toHaveBeenCalledWith('ws-blocked', null);
  });

  it('names the Slack workspace, who connected it, and disconnects after a confirm', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin', 'ws-disconnect'));
    getSlackConnection.mockResolvedValue(installedSlack);
    deleteSlackConnection.mockResolvedValue();
    renderPage();

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('by Avery Owner')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(deleteSlackConnection).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Disconnect Slack',
      })
    );

    await waitFor(() => {
      expect(deleteSlackConnection).toHaveBeenCalledWith('ws-disconnect');
    });
  });

  it('lists a workspace channel with the teams it follows', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin', 'ws-list'));
    getSlackConnection.mockResolvedValue(installedSlack);
    listChannels.mockResolvedValue([
      workspaceChannel,
      {
        ...workspaceChannel,
        channel_id: 'ch-ws-2',
        label: 'Engine feed',
        team_ids: ['team-1'],
      },
    ]);
    renderPage();

    expect(await screen.findByText('All open teams')).toBeInTheDocument();
    expect(screen.getByText('Engine')).toBeInTheDocument();
    expect(listChannels).toHaveBeenCalledWith('ws-list', null);
  });

  it('adds a workspace channel that follows the picked teams', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin', 'ws-add'));
    getSlackConnection.mockResolvedValue(installedSlack);
    const created = { ...workspaceChannel, team_ids: ['team-2'] };
    createChannel.mockImplementation(() => {
      listChannels.mockResolvedValue([created]);
      return Promise.resolve(created);
    });
    renderPage();

    expect(await screen.findByText('No channels yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).queryByRole('radio', { name: 'Incoming webhook' })
    ).toBeNull();
    expect(within(dialog).queryByLabelText('Webhook URL')).toBeNull();
    await userEvent.click(
      await within(dialog).findByRole('button', {
        name: 'Slack channel: none',
      })
    );
    await userEvent.click(
      await within(dialog).findByRole('option', { name: /#leadership/ })
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Teams: All open teams' })
    );
    await userEvent.click(
      await within(dialog).findByRole('option', { name: /Design/ })
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Teams: Design' })
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add channel' })
    );

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith(
        'ws-add',
        null,
        expect.objectContaining({
          slack_channel_id: 'C0999',
          slack_channel_name: 'leadership',
          team_ids: ['team-2'],
        })
      );
    });
    expect(listSlackChannels).toHaveBeenCalledWith('ws-add', null);
    expect(await screen.findByText('Design')).toBeInTheDocument();
    expect(screen.queryByText('No channels yet.')).toBeNull();
  });

  it('sends a test message to a workspace channel from its row', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin', 'ws-test'));
    getSlackConnection.mockResolvedValue(installedSlack);
    listChannels.mockResolvedValue([workspaceChannel]);
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Send a test message to #leadership',
      })
    );

    expect(
      await screen.findByText('Test message delivered to #leadership.')
    ).toBeInTheDocument();
    expect(testChannel).toHaveBeenCalledWith('ws-test', null, 'ch-ws');
  });
});
