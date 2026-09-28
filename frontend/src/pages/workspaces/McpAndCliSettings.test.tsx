/**
 * The MCP and CLI settings page: the server address comes from the API base
 * the application calls, it copies, each assistant tab shows its own setup,
 * the arrow keys move between tabs, and the CLI steps point at the API keys
 * and connected apps pages.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type { WorkspaceRead } from '../../types/Api';
import McpAndCliSettings from './McpAndCliSettings';

const MCP_URL = 'https://api.staging.standupless.dev/api/mcp';

vi.mock('../../config/app', async () => {
  const actual =
    await vi.importActual<typeof import('../../config/app')>(
      '../../config/app'
    );
  return {
    ...actual,
    appConfig: {
      ...actual.appConfig,
      apiBaseUrl: 'https://api.staging.standupless.dev/api',
    },
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

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context for a plain member. */
const resolved = (): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Engineering',
    slug: 'engineering',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

const writeText = vi.fn((_text: string) => Promise.resolve());

/** Mounts the page and returns a user session whose clipboard is the spy. */
const renderPage = () => {
  const user = userEvent.setup();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  render(
    <MemoryRouter initialEntries={['/w/engineering/settings/mcp-and-cli']}>
      <McpAndCliSettings />
    </MemoryRouter>
  );
  return user;
};

beforeEach(() => {
  writeText.mockClear();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
});

describe('the MCP section', () => {
  it('shows the server URL built from the configured API base', () => {
    renderPage();

    expect(screen.getByLabelText('Server URL')).toHaveValue(MCP_URL);
  });

  it('copies the server URL', async () => {
    const user = renderPage();

    await user.click(screen.getByRole('button', { name: 'Copy URL' }));

    expect(writeText).toHaveBeenCalledWith(MCP_URL);
    expect(
      await screen.findByRole('button', { name: 'Copied' })
    ).toBeInTheDocument();
  });

  it('opens on the Claude Code command and copies it', async () => {
    const user = renderPage();

    expect(screen.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await user.click(
      screen.getByRole('button', { name: 'Copy Claude Code command' })
    );

    expect(writeText).toHaveBeenCalledWith(
      `claude mcp add --transport http standupless ${MCP_URL}`
    );
  });

  it('shows each assistant its own configuration', async () => {
    const user = renderPage();

    await user.click(screen.getByRole('tab', { name: 'Cursor' }));
    const cursor = screen.getByRole('tabpanel');
    expect(within(cursor).getByText('~/.cursor/mcp.json')).toBeInTheDocument();
    expect(within(cursor).getByText(/"mcpServers"/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'VS Code' }));
    const vscode = screen.getByRole('tabpanel');
    expect(within(vscode).getByText('.vscode/mcp.json')).toBeInTheDocument();
    expect(within(vscode).getByText(/"type": "http"/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Claude' }));
    expect(
      within(screen.getByRole('tabpanel')).getByText('Add custom connector')
    ).toBeInTheDocument();
  });

  it('moves between assistants with the arrow keys', async () => {
    const user = renderPage();

    await user.click(screen.getByRole('tab', { name: 'Claude Code' }));
    await user.keyboard('{ArrowRight}');

    const claude = screen.getByRole('tab', { name: 'Claude' });
    expect(claude).toHaveAttribute('aria-selected', 'true');
    expect(claude).toHaveFocus();

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Other' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('links to the connected apps page to revoke an assistant', () => {
    renderPage();

    expect(
      within(screen.getByRole('region', { name: 'MCP server' })).getByRole(
        'link',
        { name: 'Connected apps' }
      )
    ).toHaveAttribute('href', '/w/engineering/settings/connected-apps');
  });
});

describe('the CLI section', () => {
  it('copies the install command', async () => {
    const user = renderPage();

    await user.click(
      screen.getByRole('button', { name: 'Copy pip install command' })
    );

    expect(writeText).toHaveBeenCalledWith('pip install standupless-cli');
  });

  it('points the sign in at the environment the app talks to', async () => {
    const user = renderPage();

    await user.click(
      screen.getByRole('button', { name: 'Copy sign in command' })
    );

    expect(writeText).toHaveBeenCalledWith(
      'standupless --env staging auth login'
    );
  });

  it('sends the key step to the API keys page', () => {
    renderPage();

    expect(
      screen.getByRole('link', { name: 'Create API key' })
    ).toHaveAttribute('href', '/w/engineering/settings/api-keys');
  });
});
