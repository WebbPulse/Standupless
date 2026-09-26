/**
 * The roadmap page. Covers that it sends no team list, so the server alone
 * decides which teams a caller sees, that it draws the server's order
 * rather than sorting again, that undated entries come last, and that paging
 * carries the merged cursor through.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  TeamRead,
  RoadmapEntryRead,
  RoadmapListRead,
  RollupCounts,
  WorkspaceRead,
} from '../../types/Api';
import Roadmap from './Roadmap';

const listRoadmap = vi.fn<(query: unknown) => Promise<RoadmapListRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

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

vi.mock('../../api/planning', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/planning')>(
      '../../api/planning'
    );
  return {
    ...actual,
    listRoadmap: (_w: string, query: unknown) => listRoadmap(query),
  };
});

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
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

const counts: RollupCounts = {
  todo: 1,
  in_progress: 0,
  done: 1,
  cancelled: 0,
  total: 2,
};

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

const other: TeamRead = {
  ...team,
  id: 'proj-2',
  name: 'Shell',
  key_prefix: 'SHL',
};

const entry = (over: Partial<RoadmapEntryRead> = {}): RoadmapEntryRead => ({
  kind: 'project',
  id: 'prj-1',
  team_id: 'proj-1',
  team_ids: ['proj-1'],
  name: 'Public beta',
  target_date: '2026-10-01',
  start_date: null,
  status: 'planned',
  counts,
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
    <MemoryRouter initialEntries={['/w/mine/roadmap']}>
      <Routes>
        <Route path="/w/:slug/roadmap" element={<Roadmap />} />
      </Routes>
    </MemoryRouter>
  );

/** The entry names on screen, in the order the page drew them. */
const drawnNames = (): string[] =>
  screen
    .getAllByRole('listitem')
    .map((row) => row.querySelector('span')?.textContent ?? '');

beforeEach(() => {
  listRoadmap.mockReset();
  listTeams.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listTeams.mockResolvedValue([team, other]);
  listRoadmap.mockResolvedValue({ entries: [entry()], next_cursor: null });
});

describe('reading the roadmap', () => {
  it('sends no team list, so the server decides what is visible', async () => {
    renderPage();

    await waitFor(() => {
      expect(listRoadmap).toHaveBeenCalled();
    });
    const query = listRoadmap.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(query).not.toHaveProperty('team_id');
    expect(query['limit']).toBe(50);
  });

  it('says so when nothing is planned anywhere yet', async () => {
    listRoadmap.mockResolvedValue({ entries: [], next_cursor: null });

    renderPage();

    expect(
      await screen.findByText(/Nothing is planned yet/)
    ).toBeInTheDocument();
  });

  it('draws an entry with its kind, date and counts', async () => {
    renderPage();

    expect(await screen.findByText('Public beta')).toBeInTheDocument();
    expect(screen.getByText(/Project · 2026-10-01/)).toBeInTheDocument();
    expect(screen.getByText(/2 issues/)).toBeInTheDocument();
  });

  it('links a project entry to its page and a cycle entry to its team', async () => {
    listRoadmap.mockResolvedValue({
      entries: [
        entry(),
        entry({ kind: 'cycle', id: 'cyc-1', team_id: 'proj-2' }),
      ],
      next_cursor: null,
    });

    renderPage();

    expect(await screen.findByRole('link', { name: 'Engine' })).toHaveAttribute(
      'href',
      '/w/mine/projects/prj-1?team=ENG'
    );
    expect(screen.getByRole('link', { name: 'Shell' })).toHaveAttribute(
      'href',
      '/w/mine/team/SHL/cycles'
    );
  });
});

describe('ordering', () => {
  it('draws the server order rather than sorting the page again', async () => {
    listRoadmap.mockResolvedValue({
      entries: [
        entry({ id: 'a', name: 'First', target_date: '2026-09-01' }),
        entry({ id: 'b', name: 'Second', target_date: '2026-10-01' }),
        entry({ id: 'c', name: 'Third', target_date: '2026-11-01' }),
      ],
      next_cursor: null,
    });

    renderPage();
    await screen.findByText('First');

    expect(drawnNames()).toEqual(['First', 'Second', 'Third']);
  });

  it('leaves an undated entry last, where the server placed it', async () => {
    listRoadmap.mockResolvedValue({
      entries: [
        entry({ id: 'a', name: 'Dated', target_date: '2026-09-01' }),
        entry({ id: 'b', name: 'Undated', target_date: null }),
      ],
      next_cursor: null,
    });

    renderPage();
    await screen.findByText('Dated');

    expect(drawnNames()).toEqual(['Dated', 'Undated']);
    expect(screen.getByText(/No date/)).toBeInTheDocument();
  });
});

describe('filters and paging', () => {
  it('narrows to one team without widening the read', async () => {
    renderPage();
    await screen.findByText('Public beta');

    await userEvent.selectOptions(screen.getByLabelText('Team'), 'proj-1');

    await waitFor(() => {
      expect(listRoadmap).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: 'proj-1' })
      );
    });
  });

  it('narrows to one kind of entry', async () => {
    renderPage();
    await screen.findByText('Public beta');

    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'cycle');

    await waitFor(() => {
      expect(listRoadmap).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'cycle' })
      );
    });
  });

  it('carries the merged cursor into the next page and appends it', async () => {
    listRoadmap.mockImplementation((query) => {
      const bag = query as { cursor?: string };
      if (bag.cursor === undefined) {
        return Promise.resolve({
          entries: [entry({ id: 'a', name: 'First' })],
          next_cursor: 'opaque',
        });
      }
      return Promise.resolve({
        entries: [entry({ id: 'b', name: 'Second' })],
        next_cursor: null,
      });
    });

    renderPage();
    await screen.findByText('First');

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(drawnNames()).toEqual(['First', 'Second']);
    expect(
      screen.queryByRole('button', { name: 'Load more' })
    ).not.toBeInTheDocument();
  });

  it('draws no load more when the server sent no cursor', async () => {
    renderPage();
    await screen.findByText('Public beta');

    expect(
      screen.queryByRole('button', { name: 'Load more' })
    ).not.toBeInTheDocument();
  });
});
