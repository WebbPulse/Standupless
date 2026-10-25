/**
 * The Features settings page: an admin sees a toggle and a line of copy per
 * area, each read from the workspace with a missing setting shown as on, and
 * a change saves just that area and re-reads the workspace. Anyone else is
 * told only admins can change it.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  WorkspaceRead,
  WorkspaceRole,
  WorkspaceUpdate,
} from '../../types/Api';
import FeaturesSettings from './FeaturesSettings';

const updateWorkspace =
  vi.fn<(workspaceId: string, body: WorkspaceUpdate) => Promise<unknown>>();
const refresh = vi.fn<() => Promise<void>>();

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

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return {
    ...actual,
    updateWorkspace: (workspaceId: string, body: WorkspaceUpdate) =>
      updateWorkspace(workspaceId, body),
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

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context with the caller holding `role`. */
const resolved = (
  role: WorkspaceRole,
  features?: WorkspaceRead['features']
): WorkspaceContextType => ({
  workspace: {
    id: 'ws-1',
    name: 'Engineering',
    slug: 'engineering',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
    ...(features === undefined ? {} : { features }),
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh,
});

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <FeaturesSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  updateWorkspace.mockReset();
  updateWorkspace.mockResolvedValue({});
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
});

describe('the Features settings page', () => {
  it('shows every area on, with its description, for a workspace that names none', () => {
    renderPage();

    for (const name of [
      'Initiatives',
      'Customers',
      'Releases',
      'Documents',
      'Pulse',
    ]) {
      expect(screen.getByRole('checkbox', { name })).toBeChecked();
    }
    expect(
      screen.getByText(
        'Plan what ships together and follow each release to done.'
      )
    ).toBeInTheDocument();
  });

  it('shows an area the workspace turned off as off', () => {
    useWorkspaceMock.mockReturnValue(resolved('owner', { customers: false }));
    renderPage();

    expect(
      screen.getByRole('checkbox', { name: 'Customers' })
    ).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Releases' })).toBeChecked();
  });

  it('saves only the area that changed and re-reads the workspace', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('checkbox', { name: 'Releases' }));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
      features: { releases: false },
    });
  });

  it('turns an area back on', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin', { pulse: false }));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('checkbox', { name: 'Pulse' }));

    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
        features: { pulse: true },
      });
    });
  });

  it('says a save failed', async () => {
    updateWorkspace.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('checkbox', { name: 'Documents' }));

    expect(
      await screen.findByText('Could not save this setting. Try again.')
    ).toBeInTheDocument();
  });

  it('offers a member no toggles', () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(
      screen.getByText(
        'Only workspace owners and admins can turn features on and off.'
      )
    ).toBeInTheDocument();
  });
});
