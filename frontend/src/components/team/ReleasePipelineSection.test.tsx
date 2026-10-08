/**
 * The release pipeline section. Covers a team on the default pipeline reading
 * as such, that a rename keeps the stage id while an added stage has none,
 * that reordering saves the new order, that an environment mapped twice
 * blocks the save, that a stage's issue status and publishing save with it,
 * and that a reader sees the stages without controls.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ReleasePipelineRead,
  ReleasePipelineUpdate,
  StatusRead,
} from '../../types/Api';
import ReleasePipelineSection from './ReleasePipelineSection';

const getReleasePipeline = vi.fn<() => Promise<ReleasePipelineRead>>();
const updateReleasePipeline =
  vi.fn<(body: ReleasePipelineUpdate) => Promise<ReleasePipelineRead>>();

vi.mock('../../api/releases', () => ({
  getReleasePipeline: () => getReleasePipeline(),
  updateReleasePipeline: (
    _w: string,
    _t: string,
    body: ReleasePipelineUpdate
  ) => updateReleasePipeline(body),
}));

const STATUSES: StatusRead[] = [
  { id: 'st-doing', name: 'In Progress', category: 'started', position: 1 },
  { id: 'st-done', name: 'Done', category: 'completed', position: 2 },
];

vi.mock('../../api/teams', () => ({
  listStatuses: () => Promise.resolve(STATUSES),
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

/** A two stage pipeline in the shape the contract answers with. */
const pipeline = (
  over: Partial<ReleasePipelineRead> = {}
): ReleasePipelineRead => ({
  team_id: 'team-1',
  configured: true,
  stages: [
    {
      stage_id: 'stg-1',
      name: 'Staging',
      github_environments: ['staging'],
    },
    {
      stage_id: 'stg-2',
      name: 'Production',
      github_environments: ['production'],
    },
  ],
  ...over,
});

const renderSection = (canEdit = true) =>
  render(
    <ReleasePipelineSection
      workspaceId="ws-1"
      teamId="team-1"
      canEdit={canEdit}
    />
  );

describe('ReleasePipelineSection', () => {
  beforeEach(() => {
    getReleasePipeline.mockReset();
    updateReleasePipeline.mockReset();
  });

  it('says when the team is on the default pipeline', async () => {
    getReleasePipeline.mockResolvedValue(
      pipeline({
        configured: false,
        stages: [
          {
            stage_id: 'production',
            name: 'Production',
            github_environments: [],
          },
        ],
      })
    );
    renderSection();

    expect(
      await screen.findByText('Using the default pipeline')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Stage 1 name')).toHaveValue('Production');
  });

  it('keeps the stage id on a rename and sends none for a new stage', async () => {
    const user = userEvent.setup();
    getReleasePipeline.mockResolvedValue(pipeline());
    updateReleasePipeline.mockResolvedValue(pipeline());
    renderSection();

    const name = await screen.findByLabelText('Stage 1 name');
    await user.clear(name);
    await user.type(name, 'Preview');
    await user.click(screen.getByRole('button', { name: 'Add stage' }));
    await user.type(screen.getByLabelText('Stage 3 name'), 'Canary');
    await user.type(
      screen.getByLabelText('Stage 3 GitHub environments'),
      'canary, canary-eu'
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateReleasePipeline).toHaveBeenCalledWith({
        stages: [
          {
            stage_id: 'stg-1',
            name: 'Preview',
            github_environments: ['staging'],
            status_id: null,
            publish_github_release: false,
          },
          {
            stage_id: 'stg-2',
            name: 'Production',
            github_environments: ['production'],
            status_id: null,
            publish_github_release: false,
          },
          {
            name: 'Canary',
            github_environments: ['canary', 'canary-eu'],
            status_id: null,
            publish_github_release: false,
          },
        ],
      });
    });
  });

  it('saves a new order', async () => {
    const user = userEvent.setup();
    getReleasePipeline.mockResolvedValue(pipeline());
    updateReleasePipeline.mockResolvedValue(pipeline());
    renderSection();

    await user.click(
      await screen.findByRole('button', { name: 'Move Production up' })
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateReleasePipeline).toHaveBeenCalled();
    });
    const body = updateReleasePipeline.mock.calls[0]?.[0];
    expect(body?.stages.map((stage) => stage.stage_id)).toEqual([
      'stg-2',
      'stg-1',
    ]);
  });

  it('blocks a save that maps one environment to two stages', async () => {
    const user = userEvent.setup();
    getReleasePipeline.mockResolvedValue(pipeline());
    renderSection();

    const environments = await screen.findByLabelText(
      'Stage 2 GitHub environments'
    );
    await user.clear(environments);
    await user.type(environments, 'staging');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The staging environment is mapped to two stages.'
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves the status a stage moves issues to and whether it publishes', async () => {
    const user = userEvent.setup();
    getReleasePipeline.mockResolvedValue(pipeline());
    updateReleasePipeline.mockResolvedValue(pipeline());
    renderSection();

    const status = await screen.findByLabelText('Stage 2 issue status');
    await within(status).findByRole('option', { name: 'Done' });
    await user.selectOptions(status, 'st-done');
    await user.click(
      screen.getByLabelText('Stage 2 publishes a GitHub Release')
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateReleasePipeline).toHaveBeenCalled();
    });
    const stages = updateReleasePipeline.mock.calls[0]?.[0].stages;
    expect(stages?.[0]).toMatchObject({
      status_id: null,
      publish_github_release: false,
    });
    expect(stages?.[1]).toMatchObject({
      status_id: 'st-done',
      publish_github_release: true,
    });
  });

  it('shows the saved stage settings and clears a status', async () => {
    const user = userEvent.setup();
    getReleasePipeline.mockResolvedValue(
      pipeline({
        stages: [
          {
            stage_id: 'stg-1',
            name: 'Staging',
            github_environments: ['staging'],
            status_id: 'st-doing',
            publish_github_release: true,
          },
        ],
      })
    );
    updateReleasePipeline.mockResolvedValue(pipeline());
    renderSection();

    const status = await screen.findByLabelText('Stage 1 issue status');
    await within(status).findByRole('option', { name: 'In Progress' });
    expect(status).toHaveValue('st-doing');
    expect(
      screen.getByLabelText('Stage 1 publishes a GitHub Release')
    ).toBeChecked();

    await user.selectOptions(status, '');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateReleasePipeline).toHaveBeenCalled();
    });
    expect(updateReleasePipeline.mock.calls[0]?.[0].stages[0]).toMatchObject({
      status_id: null,
      publish_github_release: true,
    });
  });

  it('shows a reader the stages without controls', async () => {
    getReleasePipeline.mockResolvedValue(pipeline());
    renderSection(false);

    expect(await screen.findByLabelText('Stage 1 name')).toHaveAttribute(
      'readonly'
    );
    expect(
      screen.queryByRole('button', { name: 'Add stage' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Stage 1 issue status')).toBeDisabled();
    expect(
      screen.getByLabelText('Stage 1 publishes a GitHub Release')
    ).toBeDisabled();
  });
});
