/**
 * The cross-workspace "my issues" page. Covers that the read is fixed to the
 * caller with `assignee_id=me`, that the rows name their project because the
 * list spans more than one, and that the filter bar leaves out the per project
 * filters this page cannot offer.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  IssueListRead,
  IssueRead,
  ProjectRead,
  WorkspaceRead,
} from '../../types/Api';
import MyIssues from './MyIssues';

const listIssues = vi.fn<(query: unknown) => Promise<IssueListRead>>();
const listProjects = vi.fn<() => Promise<ProjectRead[]>>();

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

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    listIssues: (_w: string, query: unknown) => listIssues(query),
  };
});

vi.mock('../../api/projects', () => ({
  listProjects: () => listProjects(),
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

/** One project, so a row can name where its issue lives. */
const project: ProjectRead = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

/** One issue assigned to the caller. */
const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  project_id: 'proj-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'st-1',
  priority: 'high',
  assignee_id: 'user-1',
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  milestone_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

/** A resolved workspace context, since the shell renders only once it is. */
const resolved = (): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
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

/** Mounts the page at its route, so the slug resolves for the row links. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/issues']}>
      <Routes>
        <Route path="/w/:slug/issues" element={<MyIssues />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  listIssues.mockReset();
  listProjects.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listProjects.mockResolvedValue([project]);
  listIssues.mockResolvedValue({ issues: [issue], next_cursor: null });
});

describe('my issues', () => {
  it('reads only what is assigned to the caller', async () => {
    renderPage();

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ assignee_id: 'me' })
      );
    });
  });

  it('does not fix the read to one project', async () => {
    renderPage();

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalled();
    });
    const [query] = listIssues.mock.calls[0] ?? [];
    expect(query).not.toHaveProperty('project_id');
  });

  it('names the project each issue belongs to', async () => {
    renderPage();

    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    expect(screen.getByText('Engine')).toBeInTheDocument();
  });

  it('links the key at the workspace key route', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: 'ENG-1' })).toHaveAttribute(
      'href',
      '/w/mine/issues/ENG-1'
    );
  });

  it('leaves out the per project filters, which span projects here', async () => {
    renderPage();

    await screen.findByText('Cache the token');
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Label')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Assignee')).not.toBeInTheDocument();
  });

  it('sends the search term as the q the contract reads', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Search'), 'ENG-1');

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'ENG-1', assignee_id: 'me' })
      );
    });
  });

  it('changes the sort order through the filter bar', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.selectOptions(screen.getByLabelText('Sort'), 'due_asc');

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'due_asc' })
      );
    });
  });

  it('says so when nothing is assigned', async () => {
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
    renderPage();

    expect(
      await screen.findByText('Nothing is assigned to you right now.')
    ).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listIssues.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load these issues.')
    ).toBeInTheDocument();
  });

  it('appends the next page when asked for more', async () => {
    listIssues.mockResolvedValueOnce({
      issues: [issue],
      next_cursor: 'cur-2',
    });
    listIssues.mockResolvedValue({
      issues: [{ ...issue, id: 'iss-2', key: 'ENG-2', title: 'Second' }],
      next_cursor: null,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Cache the token')).toBeInTheDocument();
    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'cur-2' })
      );
    });
  });
  it('re-reads on a filter change without remounting the list', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    const before = listIssues.mock.calls.length;

    await user.selectOptions(screen.getByLabelText('Priority'), 'high');

    await waitFor(() => {
      expect(listIssues.mock.calls.length).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'high', assignee_id: 'me' })
      );
    });
  });

  it('shows no rows from the old filters while the new read is in flight', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');

    let release: (value: IssueListRead) => void = () => undefined;
    listIssues.mockReturnValueOnce(
      new Promise<IssueListRead>((resolve) => {
        release = resolve;
      })
    );

    await user.selectOptions(screen.getByLabelText('Priority'), 'high');

    await waitFor(() => {
      expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
    });

    release({
      issues: [{ ...issue, id: 'iss-9', key: 'ENG-9', title: 'Only high' }],
      next_cursor: null,
    });

    expect(await screen.findByText('Only high')).toBeInTheDocument();
    expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
  });

  it('drops the pages loaded under the old filters', async () => {
    listIssues.mockResolvedValueOnce({
      issues: [issue],
      next_cursor: 'cur-2',
    });
    listIssues.mockResolvedValueOnce({
      issues: [{ ...issue, id: 'iss-2', key: 'ENG-2', title: 'Second' }],
      next_cursor: null,
    });
    listIssues.mockResolvedValue({
      issues: [{ ...issue, id: 'iss-9', key: 'ENG-9', title: 'Only high' }],
      next_cursor: null,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Second');

    await user.selectOptions(screen.getByLabelText('Priority'), 'high');

    expect(await screen.findByText('Only high')).toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
  });
});
