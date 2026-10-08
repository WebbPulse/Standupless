/**
 * The release page. Covers that the timeline marks the stages reached and
 * offers the rest, that advancing sends the stage id, that the commit links
 * to GitHub, that the pull request and published GitHub Release link out,
 * that adding issues names the ones that matched nothing, that an
 * issue can be removed, and that a refused delete says who may delete.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ReleaseDetailRead,
  ReleasePipelineRead,
  ReleaseStageAdvance,
  ReleaseStageRead,
  ReleaseUpdate,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import ReleaseDetail from './ReleaseDetail';

const getRelease = vi.fn<(releaseId: string) => Promise<ReleaseDetailRead>>();
const getReleasePipeline = vi.fn<() => Promise<ReleasePipelineRead>>();
const advanceRelease =
  vi.fn<(body: ReleaseStageAdvance) => Promise<ReleaseDetailRead>>();
const addReleaseIssues =
  vi.fn<(issues: string[]) => Promise<ReleaseDetailRead>>();
const removeReleaseIssue = vi.fn<(ref: string) => Promise<ReleaseDetailRead>>();
const updateRelease =
  vi.fn<(body: ReleaseUpdate) => Promise<ReleaseDetailRead>>();
const deleteRelease = vi.fn<() => Promise<void>>();
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
  getRelease: (_w: string, _t: string, releaseId: string) =>
    getRelease(releaseId),
  getReleasePipeline: () => getReleasePipeline(),
  advanceRelease: (
    _w: string,
    _t: string,
    _r: string,
    body: ReleaseStageAdvance
  ) => advanceRelease(body),
  addReleaseIssues: (_w: string, _t: string, _r: string, issues: string[]) =>
    addReleaseIssues(issues),
  removeReleaseIssue: (_w: string, _t: string, _r: string, ref: string) =>
    removeReleaseIssue(ref),
  updateRelease: (_w: string, _t: string, _r: string, body: ReleaseUpdate) =>
    updateRelease(body),
  deleteRelease: () => deleteRelease(),
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

const staging: ReleaseStageRead = {
  stage_id: 'stg-1',
  name: 'Staging',
  reached_at: '2026-10-01T00:00:00Z',
  source: 'github_deployment',
  environment: 'staging',
};

/** A release on staging carrying one issue. */
const detail = (over: Partial<ReleaseDetailRead> = {}): ReleaseDetailRead => ({
  release_id: 'rel-1',
  team_id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine 1.4',
  version: '1.4.0',
  description: null,
  source: 'github_deployment',
  repository: 'acme/engine',
  sha: 'abcdef1234567890',
  previous_sha: '1234567abcdef000',
  url: null,
  issue_count: 1,
  stages: [staging],
  current_stage: staging,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  issues: [
    {
      issue_id: 'iss-1',
      key: 'ENG-12',
      title: 'Ship the engine',
      status_id: 'st-1',
      status_category: 'completed',
    },
  ],
  notes: 'ENG-12 Ship the engine',
  skipped_issues: [],
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG/releases/rel-1']}>
      <Routes>
        <Route
          path="/w/:slug/team/:keyPrefix/releases/:releaseId"
          element={<ReleaseDetail />}
        />
        <Route
          path="/w/:slug/team/:keyPrefix/releases"
          element={<p>Release list</p>}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  getRelease.mockReset();
  getReleasePipeline.mockReset();
  advanceRelease.mockReset();
  addReleaseIssues.mockReset();
  removeReleaseIssue.mockReset();
  updateRelease.mockReset();
  deleteRelease.mockReset();
  listTeams.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved);
  listTeams.mockResolvedValue([team]);
  getRelease.mockResolvedValue(detail());
  getReleasePipeline.mockResolvedValue(pipeline);
});

describe('ReleaseDetail', () => {
  it('marks the stages reached and offers the rest', async () => {
    renderPage();

    const rows = await screen.findAllByTestId('release-stage');
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first).toHaveTextContent('Staging');
    expect(first).toHaveTextContent('Reached');
    expect(
      within(first as HTMLElement).queryByRole('button')
    ).not.toBeInTheDocument();
    expect(second).toHaveTextContent('Not reached');
    expect(
      within(second as HTMLElement).getByRole('button', {
        name: 'Advance to Production',
      })
    ).toBeInTheDocument();
    expect(getRelease).toHaveBeenCalledWith('rel-1');
  });

  it('advances by the stage id', async () => {
    const user = userEvent.setup();
    advanceRelease.mockResolvedValue(detail());
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Advance to Production' })
    );

    await waitFor(() => {
      expect(advanceRelease).toHaveBeenCalledWith({ stage: 'stg-2' });
    });
  });

  it('links the commit and the compare view on GitHub', async () => {
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'acme/engine@abcdef1' })
    ).toHaveAttribute(
      'href',
      'https://github.com/acme/engine/commit/abcdef1234567890'
    );
    expect(
      screen.getByRole('link', { name: /Compare with 1234567/ })
    ).toHaveAttribute(
      'href',
      'https://github.com/acme/engine/compare/1234567abcdef000...abcdef1234567890'
    );
    expect(screen.getByTestId('release-notes')).toHaveTextContent(
      'ENG-12 Ship the engine'
    );
  });

  it('links the pull request and the published GitHub Release', async () => {
    getRelease.mockResolvedValue(
      detail({
        pr_number: 42,
        pr_url: 'https://github.com/acme/engine/pull/42',
        github_release_url:
          'https://github.com/acme/engine/releases/tag/2026-10-07-b',
      })
    );
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'Pull request #42' })
    ).toHaveAttribute('href', 'https://github.com/acme/engine/pull/42');
    expect(
      screen.getByRole('link', { name: /GitHub Release/ })
    ).toHaveAttribute(
      'href',
      'https://github.com/acme/engine/releases/tag/2026-10-07-b'
    );
  });

  it('adds issues and names the ones that matched nothing', async () => {
    const user = userEvent.setup();
    addReleaseIssues.mockResolvedValue(detail({ skipped_issues: ['ENG-99'] }));
    renderPage();

    await user.type(
      await screen.findByLabelText('Add issues'),
      'ENG-14, ENG-99'
    );
    await user.click(screen.getByRole('button', { name: 'Add issues' }));

    await waitFor(() => {
      expect(addReleaseIssues).toHaveBeenCalledWith(['ENG-14', 'ENG-99']);
    });
    expect(
      await screen.findByText(
        'No issue in this team matched ENG-99, so it was left out.'
      )
    ).toBeInTheDocument();
  });

  it('removes an issue from the release', async () => {
    const user = userEvent.setup();
    removeReleaseIssue.mockResolvedValue(detail({ issues: [], notes: '' }));
    renderPage();

    await user.click(
      await screen.findByRole('button', {
        name: 'Remove ENG-12 from this release',
      })
    );

    await waitFor(() => {
      expect(removeReleaseIssue).toHaveBeenCalledWith('ENG-12');
    });
  });

  it('says only a team admin may delete when the delete is refused', async () => {
    const user = userEvent.setup();
    deleteRelease.mockRejectedValue(
      new ApiError({
        status: 403,
        statusText: 'Forbidden',
        body: {
          success: false,
          status: 403,
          message: 'Forbidden',
          request_id: 'req-1',
        },
        url: '/api/workspaces/ws-1/teams/proj-1/releases/rel-1',
        method: 'DELETE',
      })
    );
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Delete Engine 1.4' })
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete release' })
    );

    expect(
      await within(dialog).findByText('Only a team admin can delete a release.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Release list')).not.toBeInTheDocument();
  });
});
