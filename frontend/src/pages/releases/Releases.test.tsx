/**
 * The releases page. Covers that each row names its stage and what reported
 * it, that a team with none sees the empty state, that a further page loads
 * on request, and that recording a release sends the parsed issue keys and
 * opens the new release.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ReleaseCreate,
  ReleaseDetailRead,
  ReleaseListQuery,
  ReleaseListRead,
  ReleasePipelineRead,
  ReleaseRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import Releases, { type ReleaseCreatedState } from './Releases';

const listReleases =
  vi.fn<
    (teamId: string, query: ReleaseListQuery) => Promise<ReleaseListRead>
  >();
const getReleasePipeline = vi.fn<() => Promise<ReleasePipelineRead>>();
const createRelease =
  vi.fn<(body: ReleaseCreate) => Promise<ReleaseDetailRead>>();
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

vi.mock('../../api/releases', () => ({
  listReleases: (_w: string, teamId: string, query: ReleaseListQuery) =>
    listReleases(teamId, query),
  getReleasePipeline: () => getReleasePipeline(),
  createRelease: (_w: string, _t: string, body: ReleaseCreate) =>
    createRelease(body),
}));

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

const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Mine',
  slug: 'mine',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

const resolved: WorkspaceContextType = {
  workspace,
  isLoading: false,
  notFound: false,
  error: null,
  refresh: vi.fn(() => Promise.resolve()),
};

const pipeline: ReleasePipelineRead = {
  team_id: 'proj-1',
  configured: true,
  stages: [
    { stage_id: 'stg-1', name: 'Staging', github_environments: ['staging'] },
    {
      stage_id: 'stg-2',
      name: 'Production',
      github_environments: ['production'],
    },
  ],
};

/** A release that reached staging from a GitHub deployment. */
const release = (over: Partial<ReleaseRead> = {}): ReleaseRead => ({
  release_id: 'rel-1',
  team_id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine 1.4',
  version: '1.4.0',
  description: null,
  source: 'github_deployment',
  repository: 'acme/engine',
  sha: 'abcdef1234567890',
  previous_sha: null,
  url: null,
  issue_count: 2,
  stages: [
    {
      stage_id: 'stg-1',
      name: 'Staging',
      reached_at: '2026-10-01T00:00:00Z',
      source: 'github_deployment',
    },
  ],
  current_stage: {
    stage_id: 'stg-1',
    name: 'Staging',
    reached_at: '2026-10-01T00:00:00Z',
    source: 'github_deployment',
  },
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

/** Shows the release the page opened and the skipped keys it was handed. */
const DetailProbe = () => {
  const location = useLocation();
  const state = location.state as ReleaseCreatedState | null;
  return (
    <p data-testid="detail">
      {`${location.pathname} ${(state?.skippedIssues ?? []).join(',')}`}
    </p>
  );
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG/releases']}>
      <Routes>
        <Route
          path="/w/:slug/team/:keyPrefix/releases"
          element={<Releases />}
        />
        <Route
          path="/w/:slug/team/:keyPrefix/releases/:releaseId"
          element={<DetailProbe />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  listReleases.mockReset();
  getReleasePipeline.mockReset();
  createRelease.mockReset();
  listTeams.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved);
  listTeams.mockResolvedValue([team]);
  getReleasePipeline.mockResolvedValue(pipeline);
  listReleases.mockResolvedValue({ releases: [release()], next_cursor: null });
});

describe('Releases', () => {
  it('lists each release with its stage and source', async () => {
    renderPage();

    const row = (
      await screen.findByRole('link', { name: 'Engine 1.4' })
    ).closest('li');
    expect(row).not.toBeNull();
    const scope = within(row as HTMLElement);
    expect(scope.getByText('Staging')).toBeInTheDocument();
    expect(scope.getByText('GitHub deployment')).toBeInTheDocument();
    expect(scope.getByText('2 issues')).toBeInTheDocument();
    expect(scope.getByText('acme/engine@abcdef1')).toBeInTheDocument();
    expect(listReleases).toHaveBeenCalledWith('proj-1', { limit: 50 });
  });

  it('shows the empty state when the team has none', async () => {
    listReleases.mockResolvedValue({ releases: [], next_cursor: null });
    renderPage();

    expect(await screen.findByText(/No releases yet/)).toBeInTheDocument();
  });

  it('loads the next page on request', async () => {
    const user = userEvent.setup();
    listReleases.mockImplementation((_teamId, query) =>
      Promise.resolve(
        query.cursor === undefined
          ? { releases: [release()], next_cursor: 'cur-2' }
          : {
              releases: [release({ release_id: 'rel-2', name: 'Engine 1.3' })],
              next_cursor: null,
            }
      )
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByRole('link', { name: 'Engine 1.3' })
    ).toBeInTheDocument();
    expect(listReleases).toHaveBeenCalledWith('proj-1', {
      cursor: 'cur-2',
      limit: 50,
    });
  });

  it('records a release with the parsed issues and opens it', async () => {
    const user = userEvent.setup();
    createRelease.mockResolvedValue({
      ...release({ release_id: 'rel-9' }),
      issues: [],
      notes: '',
      skipped_issues: ['ENG-99'],
    });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'New release' })
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Version'), '1.5.0');
    await user.type(
      within(dialog).getByLabelText(/Issues/),
      'ENG-12, ENG-14 ENG-99'
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Record release' })
    );

    await waitFor(() => {
      expect(createRelease).toHaveBeenCalledWith({
        version: '1.5.0',
        issues: ['ENG-12', 'ENG-14', 'ENG-99'],
      });
    });
    expect(await screen.findByTestId('detail')).toHaveTextContent(
      '/w/mine/team/ENG/releases/rel-9 ENG-99'
    );
  });
});
