/**
 * The search page. Covers that a term too short for the index is refused here
 * rather than sent, that an issue key short circuits instead of searching, that
 * the read carries no cursor because the contract caps rather than pages, and
 * that a project filter narrows the call.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ProjectRead,
  SearchResultRead,
  WorkspaceRead,
} from '../../types/Api';
import Search from './Search';
import { hasIndexableTerm } from '../../lib/searchTerms';

const search =
  vi.fn<(q: string, query: unknown) => Promise<SearchResultRead[]>>();
const listProjects = vi.fn<() => Promise<ProjectRead[]>>();

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    search: (_w: string, q: string, query: unknown) => search(q, query),
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

/** One hit in the shape the contract answers with. */
const result = (over: Partial<SearchResultRead> = {}): SearchResultRead => ({
  issue_id: 'iss-1',
  key: 'ENG-1',
  title: 'Cache the token',
  project_id: 'proj-1',
  status_id: 'st-1',
  assignee_id: null,
  updated_at: '2026-09-17T00:00:00Z',
  score: 2,
  ...over,
});

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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/search']}>
      <Routes>
        <Route path="/w/:slug/search" element={<Search />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  search.mockReset();
  listProjects.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listProjects.mockResolvedValue([project]);
  search.mockResolvedValue([result()]);
});

describe('indexable terms', () => {
  it('accepts a word the index holds', () => {
    expect(hasIndexableTerm('cache')).toBe(true);
  });

  it('refuses words the index drops', () => {
    expect(hasIndexableTerm('a to the')).toBe(false);
  });

  it('accepts a phrase where one word is long enough', () => {
    expect(hasIndexableTerm('to the cache')).toBe(true);
  });
});

describe('search page', () => {
  it('prompts before anything is typed', async () => {
    renderPage();

    expect(
      await screen.findByText('Type a word to search the projects you can see.')
    ).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it('refuses a short term here rather than sending it', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'the');

    expect(
      await screen.findByText(
        'Search needs a word of at least four letters. Shorter words are not indexed.'
      )
    ).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it('searches once the term is long enough', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'cache');

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith('cache', expect.anything());
    });
    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
  });

  it('sends no cursor, because the route caps rather than pages', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'cache');

    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    const [, query] = search.mock.calls[0] ?? [];
    expect(query).not.toHaveProperty('cursor');
  });

  it('short circuits an issue key instead of searching for it', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'ENG-1');

    expect(
      await screen.findByRole('link', { name: 'Go to ENG-1' })
    ).toHaveAttribute('href', '/w/mine/issues/ENG-1');
    expect(search).not.toHaveBeenCalled();
  });

  it('does not search the half typed states a key passes through', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'ENG-');

    await waitFor(() => {
      expect(search).not.toHaveBeenCalled();
    });
  });

  it('narrows the search to one project when chosen', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'cache');
    await screen.findByText('Cache the token');
    await user.selectOptions(screen.getByLabelText('Project'), 'proj-1');

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith(
        'cache',
        expect.objectContaining({ project_id: 'proj-1' })
      );
    });
  });

  it('links a hit at the workspace key route', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'cache');

    expect(await screen.findByRole('link', { name: /ENG-1/ })).toHaveAttribute(
      'href',
      '/w/mine/issues/ENG-1'
    );
  });

  it('says so when nothing matched', async () => {
    search.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'cache');

    expect(
      await screen.findByText('Nothing matched that search.')
    ).toBeInTheDocument();
  });

  it('surfaces a failed search', async () => {
    search.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Find issues'), 'cache');

    expect(
      await screen.findByText('Could not run that search.')
    ).toBeInTheDocument();
  });
});
