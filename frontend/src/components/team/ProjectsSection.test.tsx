/**
 * A team's Projects settings: the team admin adds, renames and deletes the
 * team's own project labels and statuses, every write naming the team, while
 * the workspace's entries show beside them read only and another team's do
 * not show at all. Deleting a team status moves its projects onto the
 * workspace default of its category unless another is picked.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectLabelCreate,
  ProjectLabelRead,
  ProjectStatus,
  ProjectStatusCreate,
  ProjectStatusRead,
} from '../../types/Api';
import ProjectsSection from './ProjectsSection';

const listProjectLabels = vi.fn<() => Promise<ProjectLabelRead[]>>();
const createProjectLabel =
  vi.fn<(body: ProjectLabelCreate) => Promise<ProjectLabelRead>>();
const listProjectStatuses = vi.fn<() => Promise<ProjectStatusRead[]>>();
const createProjectStatus =
  vi.fn<(body: ProjectStatusCreate) => Promise<ProjectStatusRead>>();
const deleteProjectStatus =
  vi.fn<(statusId: string, replacementId?: string) => Promise<void>>();

vi.mock('../../api/projectLabels', () => ({
  listProjectLabels: () => listProjectLabels(),
  createProjectLabel: (_w: string, body: ProjectLabelCreate) =>
    createProjectLabel(body),
  updateProjectLabel: vi.fn(),
  deleteProjectLabel: vi.fn(),
}));

vi.mock('../../api/projectStatuses', () => ({
  listProjectStatuses: () => listProjectStatuses(),
  createProjectStatus: (_w: string, body: ProjectStatusCreate) =>
    createProjectStatus(body),
  updateProjectStatus: vi.fn(),
  deleteProjectStatus: (_w: string, id: string, replacementId?: string) =>
    deleteProjectStatus(id, replacementId),
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

const TEAM = 'team-a';

/** One project label row as the API answers it. */
const label = (
  id: string,
  name: string,
  teamId: string | null
): ProjectLabelRead => ({
  id,
  name,
  color: '#5e6ad2',
  description: null,
  project_count: 0,
  team_id: teamId,
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
});

/** One project status row as the API answers it. */
const status = (
  id: string,
  name: string,
  category: ProjectStatus,
  position: number,
  teamId: string | null = null,
  projectCount = 0
): ProjectStatusRead => ({
  id,
  name,
  category,
  color: null,
  description: null,
  position,
  is_default: teamId === null && position === 0,
  project_count: projectCount,
  team_id: teamId,
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
});

const statuses: ProjectStatusRead[] = [
  status('backlog', 'Backlog', 'backlog', 0),
  status('planned', 'Planned', 'planned', 0),
  status('in_progress', 'In progress', 'in_progress', 0),
  status('started', 'Started', 'in_progress', 1),
  status('review', 'In review', 'in_progress', 0, TEAM, 2),
  status('qa', 'QA', 'in_progress', 0, 'team-b'),
  status('paused', 'Paused', 'paused', 0),
  status('completed', 'Completed', 'completed', 0),
  status('canceled', 'Canceled', 'canceled', 0),
];

beforeEach(() => {
  listProjectLabels.mockReset();
  createProjectLabel.mockReset();
  listProjectStatuses.mockReset();
  createProjectStatus.mockReset();
  deleteProjectStatus.mockReset();
  listProjectLabels.mockResolvedValue([
    label('shared', 'Shared', null),
    label('mobile', 'Mobile', TEAM),
    label('growth', 'Growth', 'team-b'),
  ]);
  createProjectLabel.mockImplementation((body) =>
    Promise.resolve(label('new', body.name, body.team_id ?? null))
  );
  listProjectStatuses.mockResolvedValue(statuses);
  createProjectStatus.mockImplementation((body) =>
    Promise.resolve(status('new', body.name, body.category, 1, TEAM))
  );
  deleteProjectStatus.mockResolvedValue(undefined);
});

const renderSection = (canEdit = true) =>
  render(
    <MemoryRouter>
      <ProjectsSection workspaceId="ws-1" teamId={TEAM} canEdit={canEdit} />
    </MemoryRouter>
  );

describe('the team projects settings', () => {
  it('edits the team labels and shows the workspace ones read only', async () => {
    renderSection();
    expect(await screen.findByDisplayValue('Mobile')).toBeInTheDocument();
    const inherited = screen.getByRole('list', { name: 'Workspace labels' });
    expect(within(inherited).getByText('Shared')).toBeInTheDocument();
    expect(within(inherited).getByText('Workspace')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Shared' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Growth')).not.toBeInTheDocument();
  });

  it('adds a label to the team', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByDisplayValue('Mobile');
    await user.type(screen.getByLabelText('New project label'), 'Web');
    await user.click(screen.getByRole('button', { name: 'Add project label' }));
    await waitFor(() => {
      expect(createProjectLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Web', team_id: TEAM })
      );
    });
  });

  it('adds a status to the team beside the workspace ones', async () => {
    const user = userEvent.setup();
    renderSection();
    const started = await screen.findByRole('region', { name: 'In progress' });
    expect(within(started).getByDisplayValue('In review')).toBeInTheDocument();
    expect(within(started).getByText('Started')).toBeInTheDocument();
    expect(
      within(started).queryByRole('button', { name: 'Actions for Started' })
    ).not.toBeInTheDocument();
    expect(within(started).queryByText('QA')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Add a paused status' })
    );
    await user.type(screen.getByLabelText('New paused status'), 'Blocked');
    await user.click(screen.getByRole('button', { name: 'Add status' }));
    await waitFor(() => {
      expect(createProjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Blocked',
          category: 'paused',
          team_id: TEAM,
        })
      );
    });
  });

  it('moves a deleted team status onto the workspace default', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for In review' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete In review?',
    });
    const select = within(dialog).getByLabelText('Move projects to');
    expect(select).toHaveValue('in_progress');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['In progress', 'Started']);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteProjectStatus).toHaveBeenCalledWith('review', 'in_progress');
    });
  });

  it('shows a team member everything with nothing to edit', async () => {
    renderSection(false);
    expect(await screen.findByText('Mobile')).toBeInTheDocument();
    expect(await screen.findByText('In review')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for In review' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('New project label')
    ).not.toBeInTheDocument();
  });
});
