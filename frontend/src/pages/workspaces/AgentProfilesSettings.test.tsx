/**
 * The agent profiles settings page. Pins the empty state, that versions are read
 * only when a profile is opened, that a delete happens only after the confirmation,
 * and that a refused delete keeps the dialog open with the reason.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  AgentProfileListRead,
  AgentProfileVersionListRead,
} from '../../types/Api';
import AgentProfilesSettings from './AgentProfilesSettings';

const listMyAgentProfiles = vi.fn<() => Promise<AgentProfileListRead>>();
const listMyAgentProfileVersions =
  vi.fn<(name: string) => Promise<AgentProfileVersionListRead>>();
const deleteMyAgentProfile = vi.fn<(name: string) => Promise<void>>();

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

vi.mock('../../api/agentProfiles', () => ({
  listMyAgentProfiles: () => listMyAgentProfiles(),
  listMyAgentProfileVersions: (name: string) =>
    listMyAgentProfileVersions(name),
  deleteMyAgentProfile: (name: string) => deleteMyAgentProfile(name),
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

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: (): WorkspaceContextType => ({
    workspace: {
      id: 'ws-1',
      name: 'Engineering',
      slug: 'engineering',
      plan: 'free',
      created_at: '2026-09-17T00:00:00Z',
      role: 'member',
    },
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));

/** The caller's profiles in the shape the contract answers with. */
const listing = (names: string[]): AgentProfileListRead => ({
  versions_kept: 10,
  max_profiles: 50,
  profiles: names.map((name) => ({
    name,
    latest_version: 3,
    file_count: 4,
    total_bytes: 2048,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-14T00:00:00Z',
  })),
});

/** One profile's versions in the shape the contract answers with. */
const versions: AgentProfileVersionListRead = {
  name: 'work-laptop',
  latest_version: 3,
  versions_kept: 10,
  versions: [
    {
      version: 3,
      created_at: '2026-10-14T00:00:00Z',
      file_count: 4,
      total_bytes: 2048,
      sha256: 'a'.repeat(64),
      source: 'mcp',
      note: 'Added the memory folder',
      latest: true,
    },
    {
      version: 2,
      created_at: '2026-10-10T00:00:00Z',
      file_count: 2,
      total_bytes: 900,
      sha256: 'b'.repeat(64),
      source: 'mcp',
      latest: false,
    },
  ],
};

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <AgentProfilesSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  listMyAgentProfiles.mockReset();
  listMyAgentProfileVersions.mockReset();
  deleteMyAgentProfile.mockReset();
  listMyAgentProfiles.mockResolvedValue(listing(['work-laptop']));
  listMyAgentProfileVersions.mockResolvedValue(versions);
  deleteMyAgentProfile.mockResolvedValue(undefined);
});

describe('agent profiles settings', () => {
  it('says how to save one when there are none', async () => {
    listMyAgentProfiles.mockResolvedValue(listing([]));
    renderPage();

    expect(
      await screen.findByText(/No agent profiles yet/)
    ).toBeInTheDocument();
  });

  it('lists a profile and reads its versions only when opened', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('work-laptop')).toBeInTheDocument();
    expect(screen.getByText('4 files, 2.0 KB')).toBeInTheDocument();
    expect(listMyAgentProfileVersions).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: 'Show versions of work-laptop' })
    );

    const list = await screen.findByRole('list', {
      name: 'Versions of work-laptop',
    });
    expect(within(list).getByText('v3')).toBeInTheDocument();
    expect(within(list).getByText('Added the memory folder')).toBeVisible();
    expect(within(list).getByText('v2')).toBeInTheDocument();
    expect(listMyAgentProfileVersions).toHaveBeenCalledWith('work-laptop');
    expect(
      screen.getByText(
        'uvx --from standupless-cli standupless agent pull work-laptop'
      )
    ).toBeInTheDocument();
  });

  it('deletes only after the confirmation', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('work-laptop');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteMyAgentProfile).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Delete work-laptop?' });
    listMyAgentProfiles.mockResolvedValue(listing([]));
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete profile' })
    );

    await waitFor(() => {
      expect(deleteMyAgentProfile).toHaveBeenCalledWith('work-laptop');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('keeps the dialog open with the reason when a delete is refused', async () => {
    deleteMyAgentProfile.mockRejectedValue(new Error('Not allowed'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('work-laptop');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete work-laptop?' });
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete profile' })
    );

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
