/**
 * The workspace home page: the project list and its create form, including the
 * key prefix rule the contract fixes and the capability gate that keeps the
 * form away from a guest.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ProjectRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import WorkspaceHome from './WorkspaceHome';

const listProjects = vi.fn<() => Promise<ProjectRead[]>>();
const createProject = vi.fn<(body: unknown) => Promise<ProjectRead>>();

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

vi.mock('../../api/projects', () => ({
  listProjects: () => listProjects(),
  createProject: (_workspaceId: string, body: unknown) => createProject(body),
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

/** One project row as the list route answers it. */
const project: ProjectRead = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
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

/** Mounts the page inside a router, which the shell's links require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <WorkspaceHome />
    </MemoryRouter>
  );

beforeEach(() => {
  listProjects.mockReset();
  createProject.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
});

describe('WorkspaceHome', () => {
  it('lists the projects and links each one by its key prefix', async () => {
    listProjects.mockResolvedValue([project]);
    renderPage();

    expect(await screen.findByText('Engine')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Engine/ })).toHaveAttribute(
      'href',
      '/w/mine/p/ENG'
    );
  });

  it('says so when the workspace has no projects', async () => {
    listProjects.mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText('This workspace has no projects yet.')
    ).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listProjects.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load the projects.')
    ).toBeInTheDocument();
  });

  it('derives the key prefix from the name and caps it at six characters', async () => {
    listProjects.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('This workspace has no projects yet.');

    await user.type(screen.getByLabelText('Name'), 'Engineering');

    expect(screen.getByLabelText('Key prefix')).toHaveValue('ENGINE');
  });

  it('refuses to submit a one character key prefix, which the contract rejects', async () => {
    listProjects.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('This workspace has no projects yet.');

    await user.type(screen.getByLabelText('Name'), 'Engine');
    await user.clear(screen.getByLabelText('Key prefix'));
    await user.type(screen.getByLabelText('Key prefix'), 'E');

    expect(
      screen.getByRole('button', { name: 'Create project' })
    ).toBeDisabled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it('creates a project with the chosen estimate scale', async () => {
    listProjects.mockResolvedValue([]);
    createProject.mockResolvedValue(project);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('This workspace has no projects yet.');

    await user.type(screen.getByLabelText('Name'), 'Engine');
    await user.selectOptions(
      screen.getByLabelText('Estimate scale'),
      'fibonacci'
    );
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith({
        name: 'Engine',
        key_prefix: 'ENGINE',
        estimate_scale: 'fibonacci',
      });
    });
  });

  it('surfaces a refused create', async () => {
    listProjects.mockResolvedValue([]);
    createProject.mockRejectedValue(new Error('key prefix taken'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('This workspace has no projects yet.');

    await user.type(screen.getByLabelText('Name'), 'Engine');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(
      await screen.findByText('Could not create the project.')
    ).toBeInTheDocument();
  });

  it('hides the create form from a guest, who the contract refuses anyway', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    listProjects.mockResolvedValue([project]);
    renderPage();

    await screen.findByText('Engine');
    expect(
      screen.queryByRole('button', { name: 'Create project' })
    ).not.toBeInTheDocument();
  });

  it('points a member at the settings they do have, which is their own keys', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listProjects.mockResolvedValue([project]);
    renderPage();

    await screen.findByText('Engine');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/w/mine/settings/api-keys'
    );
    expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument();
  });

  it('points an admin at the workspace settings page itself', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    listProjects.mockResolvedValue([project]);
    renderPage();

    await screen.findByText('Engine');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/w/mine/settings'
    );
  });
});
