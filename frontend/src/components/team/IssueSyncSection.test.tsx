/**
 * The issue sync section. Covers linking a repository with the defaults,
 * that a change keeps every other setting rather than resetting it, that
 * stopping the sync deletes the link, that a team admin who cannot list
 * repositories still sees which one is linked, and that a public repository
 * only syncs one way.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GithubRepositoryRead,
  TeamSyncRead,
  TeamSyncWrite,
} from '../../types/Api';
import IssueSyncSection, {
  DEMOTED_NOTE,
  PUBLIC_REPOSITORY_NOTE,
} from './IssueSyncSection';

const getTeamSync = vi.fn<() => Promise<TeamSyncRead | null>>();
const putTeamSync = vi.fn<(body: TeamSyncWrite) => Promise<TeamSyncRead>>();
const deleteTeamSync = vi.fn<() => Promise<void>>();
const listRepositories = vi.fn<() => Promise<GithubRepositoryRead[]>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    getTeamSync: () => getTeamSync(),
    putTeamSync: (_w: string, _t: string, body: TeamSyncWrite) =>
      putTeamSync(body),
    deleteTeamSync: () => deleteTeamSync(),
    listRepositories: () => listRepositories(),
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

/** One repository the installation can see. */
const repository = (
  over: Partial<GithubRepositoryRead> = {}
): GithubRepositoryRead => ({
  repository_id: '9001',
  full_name: 'WebbPulse/standupless',
  name: 'standupless',
  private: true,
  default_branch: 'main',
  team_id: null,
  linked_at: '2026-09-26T00:00:00Z',
  ...over,
});

/** One link in the shape the contract answers with. */
const link = (over: Partial<TeamSyncRead> = {}): TeamSyncRead => ({
  team_id: 'team-1',
  repository_id: '9001',
  full_name: 'WebbPulse/standupless',
  direction: 'two_way',
  enabled: true,
  sync_labels: true,
  created_by: 'u-1',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
  ...over,
});

const renderSection = (canPickRepository = true) =>
  render(
    <IssueSyncSection
      workspaceId="ws-1"
      teamId="team-1"
      canEdit
      canPickRepository={canPickRepository}
    />
  );

beforeEach(() => {
  getTeamSync.mockReset();
  putTeamSync.mockReset();
  deleteTeamSync.mockReset();
  listRepositories.mockReset();
  getTeamSync.mockResolvedValue(null);
  putTeamSync.mockResolvedValue(link());
  deleteTeamSync.mockResolvedValue(undefined);
  listRepositories.mockResolvedValue([
    repository(),
    repository({ repository_id: '9002', full_name: 'WebbPulse/docs' }),
  ]);
});

describe('the issue sync section', () => {
  it('links a repository with the defaults', async () => {
    renderSection();

    const select = await screen.findByLabelText('Repository');
    await screen.findByRole('option', { name: 'WebbPulse/docs' });
    await userEvent.selectOptions(select, '9002');

    await waitFor(() => {
      expect(putTeamSync).toHaveBeenCalledWith({ repository_id: '9002' });
    });
  });

  it('keeps the other settings when one changes', async () => {
    getTeamSync.mockResolvedValue(link({ sync_labels: false }));
    renderSection();

    await userEvent.click(await screen.findByLabelText('Sync is on'));

    await waitFor(() => {
      expect(putTeamSync).toHaveBeenCalledWith({
        repository_id: '9001',
        direction: 'two_way',
        enabled: false,
        sync_labels: false,
      });
    });
  });

  it('stops syncing', async () => {
    getTeamSync.mockResolvedValue(link());
    renderSection();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Stop syncing' })
    );

    await waitFor(() => {
      expect(deleteTeamSync).toHaveBeenCalled();
    });
  });

  it('shows the linked repository to a team admin who cannot list them', async () => {
    getTeamSync.mockResolvedValue(link());
    renderSection(false);

    expect(
      await screen.findByText('WebbPulse/standupless')
    ).toBeInTheDocument();
    expect(listRepositories).not.toHaveBeenCalled();
  });

  it('links a public repository one way', async () => {
    listRepositories.mockResolvedValue([
      repository(),
      repository({
        repository_id: '9003',
        full_name: 'WebbPulse/open',
        private: false,
      }),
    ]);
    renderSection();

    const select = await screen.findByLabelText('Repository');
    await screen.findByRole('option', { name: 'WebbPulse/open' });
    await userEvent.selectOptions(select, '9003');

    await waitFor(() => {
      expect(putTeamSync).toHaveBeenCalledWith({
        repository_id: '9003',
        direction: 'github_to_standupless',
      });
    });
  });

  it('disables both ways for a public repository and says why', async () => {
    getTeamSync.mockResolvedValue(
      link({ direction: 'github_to_standupless', repository_private: false })
    );
    renderSection();

    expect(await screen.findByText(PUBLIC_REPOSITORY_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Both ways' })).toBeDisabled();
  });

  it('offers both ways for a private repository', async () => {
    getTeamSync.mockResolvedValue(link({ repository_private: true }));
    renderSection();

    expect(
      await screen.findByRole('option', { name: 'Both ways' })
    ).toBeEnabled();
    expect(screen.queryByText(PUBLIC_REPOSITORY_NOTE)).not.toBeInTheDocument();
  });

  it('says when sync dropped to one way because the repository went public', async () => {
    getTeamSync.mockResolvedValue(
      link({
        direction: 'github_to_standupless',
        repository_private: false,
        public_demoted_at: '2026-10-06T00:00:00Z',
      })
    );
    renderSection();

    expect(await screen.findByText(DEMOTED_NOTE)).toBeInTheDocument();
  });
});
