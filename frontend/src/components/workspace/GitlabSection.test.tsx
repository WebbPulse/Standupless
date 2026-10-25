/**
 * The workspace GitLab connections. The behaviour worth pinning is the secret:
 * it comes back from the connect and the rotate and from nothing else, so both
 * must surface it once with the webhook URL and the list must never show it.
 * Also covers an environment that cannot store tokens, a token GitLab refused
 * shown in the server's own words, and the confirm in front of a disconnect.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { clearPolledQueryCache } from '@webbpulse/api-client/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GitlabConnectionCreated,
  GitlabConnectionRead,
  GitlabConnectionsRead,
} from '../../types/Api';
import GitlabSection from './GitlabSection';

const listGitlabConnections = vi.fn<() => Promise<GitlabConnectionsRead>>();
const createGitlabConnection =
  vi.fn<(body: unknown) => Promise<GitlabConnectionCreated>>();
const rotateGitlabSecret =
  vi.fn<(id: string) => Promise<GitlabConnectionCreated>>();
const deleteGitlabConnection = vi.fn<(id: string) => Promise<void>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listGitlabConnections: () => listGitlabConnections(),
    createGitlabConnection: (_w: string, body: unknown) =>
      createGitlabConnection(body),
    rotateGitlabSecret: (_w: string, id: string) => rotateGitlabSecret(id),
    deleteGitlabConnection: (_w: string, id: string) =>
      deleteGitlabConnection(id),
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

/** One connection in the shape the contract answers with. */
const connection = (
  over: Partial<GitlabConnectionRead> = {}
): GitlabConnectionRead => ({
  connection_id: 'gl-1',
  instance_url: 'https://gitlab.com',
  scope_kind: 'group',
  scope_id: '1234',
  scope_path: 'acme',
  scope_name: 'Acme',
  web_url: 'https://gitlab.com/groups/acme',
  token_hint: 'WXYZ',
  webhook_url: 'https://api.example.test/api/gitlab/webhooks/ws-1/gl-1',
  connected_by: 'user-1',
  connected_at: '2026-10-25T00:00:00Z',
  secret_rotated_at: null,
  ...over,
});

beforeEach(() => {
  clearPolledQueryCache();
  listGitlabConnections.mockReset();
  createGitlabConnection.mockReset();
  rotateGitlabSecret.mockReset();
  deleteGitlabConnection.mockReset();
  listGitlabConnections.mockResolvedValue({
    configured: true,
    connections: [connection()],
  });
  createGitlabConnection.mockResolvedValue({
    ...connection({ connection_id: 'gl-2', scope_path: 'acme/web' }),
    webhook_secret: 'glsec_created',
  });
  rotateGitlabSecret.mockResolvedValue({
    ...connection(),
    webhook_secret: 'glsec_rotated',
  });
  deleteGitlabConnection.mockResolvedValue(undefined);
});

/** Opens a row's action menu and picks one item. */
const pickAction = async (label: string, item: string): Promise<void> => {
  await userEvent.click(
    await screen.findByRole('button', { name: `${label} actions` })
  );
  await userEvent.click(screen.getByRole('menuitem', { name: item }));
};

describe('the GitLab connections', () => {
  it('lists a connection with its token ending and webhook URL, never a secret', async () => {
    render(<GitlabSection workspaceId="ws-1" />);

    const list = await screen.findByRole('list', {
      name: 'GitLab connections',
    });
    expect(list).toHaveTextContent('acme');
    expect(list).toHaveTextContent('token ending WXYZ');
    expect(list).toHaveTextContent('/api/gitlab/webhooks/ws-1/gl-1');
    expect(screen.queryByText(/glsec_/)).not.toBeInTheDocument();
  });

  it('says so when the environment cannot store GitLab tokens', async () => {
    listGitlabConnections.mockResolvedValue({
      configured: false,
      connections: [],
    });
    render(<GitlabSection workspaceId="ws-1" />);

    expect(
      await screen.findByText(
        'This environment cannot store GitLab tokens yet.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Connect GitLab' })
    ).not.toBeInTheDocument();
  });

  it('connects a project and shows its webhook secret once', async () => {
    render(<GitlabSection workspaceId="ws-1" />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect GitLab' })
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Connect a'),
      'project'
    );
    await userEvent.type(screen.getByLabelText('Project path'), 'acme/web');
    await userEvent.type(screen.getByLabelText('Access token'), 'glpat-x');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(createGitlabConnection).toHaveBeenCalledWith({
        instance_url: '',
        scope_kind: 'project',
        scope_path: 'acme/web',
        access_token: 'glpat-x',
      });
    });
    expect(await screen.findByText('glsec_created')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'The secret is shown once'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('glsec_created')).not.toBeInTheDocument();
  });

  it('shows a token GitLab refused in the server words and keeps the form open', async () => {
    createGitlabConnection.mockRejectedValue(
      new ApiError({
        status: 422,
        statusText: 'Unprocessable Entity',
        body: {
          error_code: 'GITLAB_TOKEN_REJECTED',
          message: 'GitLab did not accept that access token.',
        },
        url: '/api/workspaces/ws-1/gitlab/connections',
        method: 'POST',
      })
    );
    render(<GitlabSection workspaceId="ws-1" />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect GitLab' })
    );
    await userEvent.type(screen.getByLabelText('Group path'), 'acme');
    await userEvent.type(screen.getByLabelText('Access token'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(
      await screen.findByText('GitLab did not accept that access token.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Access token')).toBeInTheDocument();
  });

  it('rotates the secret after a confirm and shows the new one', async () => {
    render(<GitlabSection workspaceId="ws-1" />);

    await pickAction('acme', 'Rotate secret');
    await userEvent.click(
      screen.getByRole('button', { name: 'Rotate secret' })
    );

    await waitFor(() => {
      expect(rotateGitlabSecret).toHaveBeenCalledWith('gl-1');
    });
    expect(await screen.findByText('glsec_rotated')).toBeInTheDocument();
  });

  it('disconnects only after a confirm', async () => {
    render(<GitlabSection workspaceId="ws-1" />);

    await pickAction('acme', 'Disconnect');
    expect(deleteGitlabConnection).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Links already made stay on their issues/)
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => {
      expect(deleteGitlabConnection).toHaveBeenCalledWith('gl-1');
    });
  });
});
