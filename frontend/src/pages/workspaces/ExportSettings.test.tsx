/**
 * The workspace export page. An admin starts an export with or without member
 * emails, sees each job's state, and downloads through a fresh read of the job
 * rather than a link the list held. Anyone below admin is told they cannot.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  WorkspaceExportCreate,
  WorkspaceExportRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ExportSettings from './ExportSettings';

const listWorkspaceExports = vi.fn<() => Promise<WorkspaceExportRead[]>>();
const startWorkspaceExport =
  vi.fn<(body: WorkspaceExportCreate) => Promise<WorkspaceExportRead>>();
const getWorkspaceExport =
  vi.fn<(exportId: string) => Promise<WorkspaceExportRead>>();
const assign = vi.fn<(url: string) => void>();

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

vi.mock('../../api/exports', () => ({
  listWorkspaceExports: () => listWorkspaceExports(),
  startWorkspaceExport: (_workspaceId: string, body: WorkspaceExportCreate) =>
    startWorkspaceExport(body),
  getWorkspaceExport: (_workspaceId: string, exportId: string) =>
    getWorkspaceExport(exportId),
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

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
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

/** One export job in the shape the contract answers with. */
const job = (over: Partial<WorkspaceExportRead> = {}): WorkspaceExportRead => ({
  export_id: 'exp-1',
  workspace_id: 'ws-1',
  status: 'ready',
  format_version: 1,
  requested_by: 'user-1',
  emails_masked: false,
  created_at: '2026-10-07T00:00:00Z',
  size_bytes: 2048,
  counts: { issues: 12 },
  download_url: null,
  ...over,
});

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <ExportSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  listWorkspaceExports.mockReset();
  startWorkspaceExport.mockReset();
  getWorkspaceExport.mockReset();
  assign.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
  listWorkspaceExports.mockResolvedValue([job()]);
  startWorkspaceExport.mockResolvedValue(job({ status: 'queued' }));
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

describe('the workspace export page', () => {
  it('lists a ready export with its issue count and size', async () => {
    renderPage();

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('12 issues, 2.0 KB')).toBeInTheDocument();
  });

  it('starts an export with emails by default', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Start export' })
    );

    await waitFor(() => {
      expect(startWorkspaceExport).toHaveBeenCalledWith({
        include_emails: true,
      });
    });
  });

  it('masks emails when asked', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Mask member emails'));
    await user.click(screen.getByRole('button', { name: 'Start export' }));

    await waitFor(() => {
      expect(startWorkspaceExport).toHaveBeenCalledWith({
        include_emails: false,
      });
    });
  });

  it('refuses a second start while one is building', async () => {
    listWorkspaceExports.mockResolvedValue([job({ status: 'running' })]);
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Export in progress' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /Download/ })).toBeDisabled();
  });

  it('downloads through a fresh read of the job', async () => {
    const user = userEvent.setup();
    getWorkspaceExport.mockResolvedValue(
      job({ download_url: 'https://bucket.example/bundle.zip?sig=1' })
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Download/ }));

    await waitFor(() => {
      expect(getWorkspaceExport).toHaveBeenCalledWith('exp-1');
      expect(assign).toHaveBeenCalledWith(
        'https://bucket.example/bundle.zip?sig=1'
      );
    });
  });

  it('says so when there are no exports', async () => {
    listWorkspaceExports.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No exports yet.')).toBeInTheDocument();
  });

  it('tells a member only admins can export', () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(
      screen.getByText(
        'Only workspace owners and admins can export the workspace.'
      )
    ).toBeInTheDocument();
    expect(listWorkspaceExports).not.toHaveBeenCalled();
  });
});
