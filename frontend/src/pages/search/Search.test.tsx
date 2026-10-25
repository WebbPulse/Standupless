/**
 * The search page. Covers that a term too short for the index is refused here
 * rather than sent, that an issue key short circuits instead of searching, that
 * the read carries no cursor because the contract caps rather than pages, that
 * the team and status filters narrow the call, that the term and filters live
 * in the address, that each kind of hit is grouped and linked, and that
 * Escape clears the term before it leaves search.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  MemberRead,
  SearchListRead,
  TeamRead,
  SearchResultRead,
  WorkspaceRead,
} from '../../types/Api';
import Search from './Search';
import { hasIndexableTerm } from '../../lib/searchTerms';
import {
  readRecentSearches,
  recordRecentSearch,
} from '../../lib/recentSearches';

const search =
  vi.fn<(q: string, query: unknown) => Promise<SearchResultRead[]>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const others = vi.fn<() => Omit<Required<SearchListRead>, 'results'>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();

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

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    search: (_w: string, q: string, query: unknown) => search(q, query),
    searchAll: async (_w: string, q: string, query: unknown) => ({
      results: await search(q, query),
      ...others(),
    }),
  };
});

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
}));

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return {
    ...actual,
    listMembers: () => listMembers(),
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

const team: TeamRead = {
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
  team_id: 'proj-1',
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

/** Prints the address the page has written, so a test can read it back. */
const Address = () => {
  const location = useLocation();
  return <output aria-label="Address">{location.search}</output>;
};

const renderPage = (entry = '/w/mine/search', before: string[] = []) =>
  render(
    <MemoryRouter
      initialEntries={[...before, entry]}
      initialIndex={before.length}
    >
      <Routes>
        <Route path="/w/:slug" element={<p>Workspace home</p>} />
        <Route path="/w/:slug/inbox" element={<p>Inbox page</p>} />
        <Route
          path="/w/:slug/search"
          element={
            <>
              <Search />
              <Address />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

const member: MemberRead = {
  user_id: 'user-1',
  email: 'ada@example.com',
  display_name: 'Ada',
  role: 'member',
  joined_at: '2026-09-17T00:00:00Z',
  avatar_url: null,
};

const noOthers = (): Omit<Required<SearchListRead>, 'results'> => ({
  documents: [],
  projects: [],
  initiatives: [],
  comments: [],
});

beforeEach(() => {
  search.mockReset();
  listTeams.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listTeams.mockResolvedValue([team]);
  search.mockResolvedValue([result()]);
  others.mockReset();
  others.mockImplementation(noOthers);
  listMembers.mockReset();
  listMembers.mockResolvedValue([member]);
  globalThis.localStorage.clear();
});

describe('indexable terms', () => {
  it('accepts a word the index holds', () => {
    expect(hasIndexableTerm('cache')).toBe(true);
  });

  it('accepts two and three letter words', () => {
    expect(hasIndexableTerm('ui')).toBe(true);
    expect(hasIndexableTerm('csv')).toBe(true);
  });

  it('refuses single characters, which the index drops', () => {
    expect(hasIndexableTerm('a b')).toBe(false);
  });

  it('accepts a phrase where one word is long enough', () => {
    expect(hasIndexableTerm('a cache')).toBe(true);
  });
});

describe('search page', () => {
  it('prompts before anything is typed', async () => {
    renderPage();

    expect(
      await screen.findByText('Type a word to search the teams you can see.')
    ).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it('waits for a second character rather than sending one', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'u');

    expect(
      await screen.findByText('Keep typing to search.')
    ).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it('searches a two letter word', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'ui');

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith('ui', expect.anything());
    });
  });

  it('searches once the term is long enough', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'cache');

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith('cache', expect.anything());
    });
    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
  });

  it('sends no cursor, because the route caps rather than pages', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'cache');

    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    const [, query] = search.mock.calls[0] ?? [];
    expect(query).not.toHaveProperty('cursor');
  });

  it('short circuits an issue key instead of searching for it', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'ENG-1');

    expect(
      await screen.findByRole('link', { name: 'Go to ENG-1' })
    ).toHaveAttribute('href', '/w/mine/issues/ENG-1');
    expect(search.mock.calls.map((call) => call[0])).not.toContain('ENG-1');
  });

  it('does not search the half typed states a key passes through', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'ENG-');

    await waitFor(() => {
      expect(search.mock.calls.map((call) => call[0])).not.toContain('ENG-');
    });
  });

  it('narrows the search to one team when chosen', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'cache');
    await screen.findByText('Cache the token');
    await user.selectOptions(screen.getByLabelText('Team'), 'proj-1');

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith(
        'cache',
        expect.objectContaining({ team_id: 'proj-1' })
      );
    });
  });

  it('links a hit at the workspace key route', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'cache');

    expect(await screen.findByRole('link', { name: /ENG-1/ })).toHaveAttribute(
      'href',
      '/w/mine/issues/ENG-1'
    );
  });

  it('says so when nothing matched', async () => {
    search.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'cache');

    expect(
      await screen.findByText('Nothing matched that search.')
    ).toBeInTheDocument();
  });

  it('surfaces a failed search', async () => {
    search.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'cache');

    expect(
      await screen.findByText('Could not run that search.')
    ).toBeInTheDocument();
  });

  it('restores the term and filters from the address on load', async () => {
    renderPage('/w/mine/search?q=cache&team=proj-1&status=started');

    expect(screen.getByLabelText('Search')).toHaveValue('cache');
    await waitFor(() => {
      expect(search).toHaveBeenCalledWith(
        'cache',
        expect.objectContaining({
          team_id: 'proj-1',
          status_category: 'started',
        })
      );
    });
    expect(screen.getByLabelText('Status')).toHaveValue('started');
  });

  it('keeps the term and filters in the address', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'cache');
    await screen.findByText('Cache the token');
    await user.selectOptions(screen.getByLabelText('Status'), 'completed');

    const address = new URLSearchParams(
      screen.getByLabelText('Address').textContent ?? ''
    );
    expect(address.get('q')).toBe('cache');
    expect(address.get('status')).toBe('completed');
  });

  it('shows the status, team and assignee of an issue hit', async () => {
    search.mockResolvedValue([
      result({
        status_name: 'In Progress',
        status_category: 'started',
        status_color: '#f2c94c',
        status_icon: null,
        assignee_id: 'user-1',
      }),
    ]);
    renderPage('/w/mine/search?q=cache');

    expect(
      await screen.findByRole('img', { name: 'In Progress' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ENG-1/ })).toHaveTextContent(
      'Engine'
    );
    expect(
      await screen.findByRole('img', { name: 'Assigned to Ada' })
    ).toBeInTheDocument();
  });

  it('groups projects, initiatives and comments, linking a comment to itself', async () => {
    others.mockReturnValue({
      documents: [],
      projects: [
        {
          project_id: 'pj-1',
          name: 'Cache rollout',
          status: 'in_progress',
          health: null,
          icon: null,
          color: null,
          lead_id: null,
          team_ids: ['proj-1'],
          target_date: null,
          updated_at: '2026-09-17T00:00:00Z',
        },
      ],
      initiatives: [
        {
          initiative_id: 'in-1',
          name: 'Cache everything',
          status: 'active',
          health: null,
          owner_id: null,
          target_date: null,
          updated_at: '2026-09-17T00:00:00Z',
        },
      ],
      comments: [
        {
          comment_id: 'cm-1',
          issue_id: 'iss-2',
          issue_key: 'ENG-2',
          issue_title: 'Slow login',
          team_id: 'proj-1',
          author_id: 'user-1',
          snippet: 'The cache expires too early',
          created_at: '2026-09-17T00:00:00Z',
        },
      ],
    });
    renderPage('/w/mine/search?q=cache');

    expect(
      await screen.findByRole('heading', { name: /Projects/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Initiatives/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Cache rollout/ })).toHaveAttribute(
      'href',
      '/w/mine/projects/pj-1'
    );
    expect(
      screen.getByRole('link', { name: /Cache everything/ })
    ).toHaveAttribute('href', '/w/mine/initiatives/in-1');
    expect(screen.getByRole('link', { name: /Slow login/ })).toHaveAttribute(
      'href',
      '/w/mine/issues/ENG-2#comment-cm-1'
    );
    expect(screen.getByText('The cache expires too early')).toBeInTheDocument();
  });

  it('narrows to one kind on its tab and remembers the tab', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/search?q=cache');

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('tab', { name: /Comments/ }));

    expect(
      await screen.findByText('No comments matched that search.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toHaveTextContent('type=comments');
  });

  it('clears the term on the first Escape and keeps focus in the input', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/search?q=cache&team=proj-1');

    await screen.findByText('Cache the token');
    const input = screen.getByRole('searchbox');
    input.focus();
    await user.keyboard('{Escape}');

    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.getByLabelText('Address')).not.toHaveTextContent('q=');
    expect(screen.getByLabelText('Address')).toHaveTextContent('team=proj-1');
    expect(
      await screen.findByText('Type a word to search the teams you can see.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
  });

  it('goes back on Escape once the term is empty', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/search?q=cache', ['/w/mine/inbox']);

    await screen.findByText('Cache the token');
    screen.getByRole('searchbox').focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('searchbox')).toHaveValue('');

    await user.keyboard('{Escape}');

    expect(await screen.findByText('Inbox page')).toBeInTheDocument();
  });

  it('goes to the workspace home on Escape when search has no history', async () => {
    const user = userEvent.setup();
    renderPage();

    screen.getByRole('searchbox').focus();
    await user.keyboard('{Escape}');

    expect(await screen.findByText('Workspace home')).toBeInTheDocument();
  });
});

describe('recent searches', () => {
  const stored = () =>
    readRecentSearches('ws-1').map((row) => [
      row.q,
      row.team,
      row.type,
      row.status,
    ]);

  /** Moves focus off the term and back, so the list opens the way a person opens it. */
  const focusTerm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(document.body);
    await user.click(screen.getByLabelText('Search'));
  };

  it('offers nothing before a search has been run', () => {
    renderPage();

    expect(
      screen.queryByRole('listbox', { name: 'Recent searches' })
    ).not.toBeInTheDocument();
  });

  it('remembers a search with its filters when Enter is pressed', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/search?team=proj-1&status=started');

    await user.type(screen.getByLabelText('Search'), 'cache{Enter}');

    expect(stored()).toEqual([['cache', 'proj-1', '', 'started']]);
  });

  it('remembers a search when one of its hits is opened', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'cache');
    await user.click(await screen.findByRole('link', { name: /ENG-1/ }));

    expect(stored()).toEqual([['cache', '', '', '']]);
  });

  it('does not remember an issue key', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Search'), 'ENG-12{Enter}');

    expect(stored()).toEqual([]);
  });

  it('lists recent searches on an empty focused term, newest first', async () => {
    recordRecentSearch('ws-1', { q: 'cache', team: '', type: '', status: '' });
    recordRecentSearch('ws-1', {
      q: 'token',
      team: 'proj-1',
      type: 'issues',
      status: '',
    });
    const user = userEvent.setup();
    renderPage();
    await focusTerm(user);

    const list = await screen.findByRole('listbox', {
      name: 'Recent searches',
    });
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('token'),
      expect.stringContaining('cache'),
    ]);
    await waitFor(() => {
      expect(options[0]).toHaveTextContent('Engine · Issues');
    });
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('hides the list once a term is typed', async () => {
    recordRecentSearch('ws-1', { q: 'cache', team: '', type: '', status: '' });
    const user = userEvent.setup();
    renderPage();
    await focusTerm(user);

    await screen.findByRole('listbox', { name: 'Recent searches' });
    await user.type(screen.getByLabelText('Search'), 'to');

    expect(
      screen.queryByRole('listbox', { name: 'Recent searches' })
    ).not.toBeInTheDocument();
  });

  it('reruns a recent search on arrow and Enter, restoring its filters', async () => {
    recordRecentSearch('ws-1', { q: 'cache', team: '', type: '', status: '' });
    recordRecentSearch('ws-1', {
      q: 'token',
      team: 'proj-1',
      type: 'issues',
      status: 'started',
    });
    const user = userEvent.setup();
    renderPage();

    const input = screen.getByLabelText('Search');
    await focusTerm(user);
    await screen.findByRole('listbox', { name: 'Recent searches' });
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id);
    await user.keyboard('{Enter}');

    expect(input).toHaveValue('token');
    const address = new URLSearchParams(
      screen.getByLabelText('Address').textContent ?? ''
    );
    expect(address.get('q')).toBe('token');
    expect(address.get('team')).toBe('proj-1');
    expect(address.get('type')).toBe('issues');
    expect(address.get('status')).toBe('started');
    await waitFor(() => {
      expect(search).toHaveBeenCalledWith(
        'token',
        expect.objectContaining({
          team_id: 'proj-1',
          status_category: 'started',
        })
      );
    });
  });

  it('reruns a recent search when its row is clicked', async () => {
    recordRecentSearch('ws-1', { q: 'cache', team: '', type: '', status: '' });
    const user = userEvent.setup();
    renderPage();
    await focusTerm(user);

    await user.click(await screen.findByRole('option', { name: /cache/ }));

    expect(screen.getByLabelText('Search')).toHaveValue('cache');
    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
  });

  it('removes one recent search and keeps focus in the term', async () => {
    recordRecentSearch('ws-1', { q: 'cache', team: '', type: '', status: '' });
    recordRecentSearch('ws-1', { q: 'token', team: '', type: '', status: '' });
    const user = userEvent.setup();
    renderPage();
    await focusTerm(user);

    await user.click(
      await screen.findByRole('button', {
        name: 'Remove cache from recent searches',
      })
    );

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByLabelText('Search')).toHaveFocus();
    expect(stored()).toEqual([['token', '', '', '']]);
  });

  it('clears every recent search', async () => {
    recordRecentSearch('ws-1', { q: 'cache', team: '', type: '', status: '' });
    const user = userEvent.setup();
    renderPage();
    await focusTerm(user);

    await user.click(
      await screen.findByRole('button', { name: 'Clear recent' })
    );

    expect(
      screen.queryByRole('listbox', { name: 'Recent searches' })
    ).not.toBeInTheDocument();
    expect(stored()).toEqual([]);
  });

  it('still searches when storage is unavailable', async () => {
    const reads = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    const writes = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    const user = userEvent.setup();
    try {
      renderPage();

      await user.type(screen.getByLabelText('Search'), 'cache{Enter}');

      expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    } finally {
      reads.mockRestore();
      writes.mockRestore();
    }
  });
});
