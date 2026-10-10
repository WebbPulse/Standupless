/**
 * The releases page. Covers that each row names its stage, progress,
 * repository and creator, that rows group by whether they reached the final
 * stage and a group folds, that the URL filters narrow the list, that j and
 * Enter open a release, that a team with none sees the empty state with a
 * pipeline link, that a further page loads on request, and that recording a
 * release sends the parsed issue keys and opens the new release.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  MemberRead,
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

const member: MemberRead = {
  user_id: 'user-1',
  email: 'ada@example.com',
  display_name: 'Ada Lovelace',
  role: 'member',
  joined_at: '2026-09-17T00:00:00Z',
};

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => [member],
}));

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

/** A release that reached production, recorded by a member. */
const shipped = (): ReleaseRead =>
  release({
    release_id: 'rel-2',
    name: 'Engine 1.3',
    version: '1.3.0',
    repository: 'acme/api',
    issue_count: 3,
    status_counts: { completed: 2, started: 1 },
    created_by: 'user-1',
    current_stage: {
      stage_id: 'stg-2',
      name: 'Production',
      reached_at: '2026-10-02T00:00:00Z',
      source: 'manual',
    },
  });

const renderPage = (search = '') =>
  render(
    <MemoryRouter initialEntries={[`/w/mine/team/ENG/releases${search}`]}>
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
  localStorage.clear();
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
    expect(scope.getByLabelText('2 issues')).toBeInTheDocument();
    expect(scope.getByText('acme/engine')).toBeInTheDocument();
    expect(scope.getByText('abcdef1')).toBeInTheDocument();
    expect(
      scope.getByLabelText('Recorded from a GitHub deployment')
    ).toBeInTheDocument();
    expect(listReleases).toHaveBeenCalledWith('proj-1', { limit: 50 });
  });

  it('groups releases by stage and folds a group', async () => {
    const user = userEvent.setup();
    listReleases.mockResolvedValue({
      releases: [release(), shipped()],
      next_cursor: null,
    });
    renderPage();

    const released = await screen.findByRole('region', { name: 'Released' });
    const row = within(released)
      .getByRole('link', { name: 'Engine 1.3' })
      .closest('li') as HTMLElement;
    expect(within(row).getByText('Production')).toBeInTheDocument();
    expect(within(row).getByText('2/3')).toBeInTheDocument();
    expect(
      within(row).getByLabelText('Created by Ada Lovelace')
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'In progress' })).getByRole(
        'link',
        { name: 'Engine 1.4' }
      )
    ).toBeInTheDocument();

    await user.click(
      within(released).getByRole('button', { name: /Released/ })
    );

    expect(
      screen.queryByRole('link', { name: 'Engine 1.3' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Engine 1.4' })
    ).toBeInTheDocument();
  });

  it('narrows the list by the stage and repository in the URL', async () => {
    listReleases.mockResolvedValue({
      releases: [release(), shipped()],
      next_cursor: null,
    });
    renderPage('?stage=stg-2');

    expect(
      await screen.findByRole('link', { name: 'Engine 1.3' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Engine 1.4' })
    ).not.toBeInTheDocument();
  });

  it('says when no release matches the filters', async () => {
    renderPage('?repo=acme%2Fother');

    expect(
      await screen.findByText('No releases match these filters.')
    ).toBeInTheDocument();
  });

  it('opens the highlighted release on Enter', async () => {
    const user = userEvent.setup();
    listReleases.mockResolvedValue({
      releases: [release(), shipped()],
      next_cursor: null,
    });
    renderPage();
    await screen.findByRole('link', { name: 'Engine 1.3' });

    await user.keyboard('jj{Enter}');

    expect(await screen.findByTestId('detail')).toHaveTextContent(
      '/w/mine/team/ENG/releases/rel-2'
    );
  });

  it('shows the empty state when the team has none', async () => {
    listReleases.mockResolvedValue({ releases: [], next_cursor: null });
    renderPage();

    expect(await screen.findByText(/No releases yet/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Set up the pipeline' })
    ).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/settings#team-settings-releases'
    );
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
