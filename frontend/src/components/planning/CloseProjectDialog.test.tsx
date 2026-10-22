/**
 * The open issue question a project close asks. Covers that keep is the
 * default, that a move waits on a target and sends it, that cancel sends no
 * target, that a move with nowhere to go is not offered, and the helpers that
 * decide when to ask and which projects the issues may move to.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  asksAboutOpenIssues,
  moveTargets,
  openIssueCount,
} from '../../hooks/useCloseProjectPrompt';
import type { ProjectRead } from '../../types/Api';
import CloseProjectDialog from './CloseProjectDialog';

const project = (overrides: Partial<ProjectRead> = {}): ProjectRead => ({
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: null,
  name: 'Launch',
  description: null,
  target_date: null,
  status: 'in_progress',
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
  counts: { todo: 2, in_progress: 1, done: 4, cancelled: 1, total: 8 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  ...overrides,
});

const next = project({ project_id: 'prj-2', name: 'Next' });

const renderDialog = (
  status: 'completed' | 'canceled' = 'completed',
  targets: ProjectRead[] = [next]
) => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <CloseProjectDialog
      project={project()}
      status={status}
      openIssues={3}
      targets={targets}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
  return { onConfirm, onClose };
};

describe('CloseProjectDialog', () => {
  it('names the open issues and keeps them by default', async () => {
    const { onConfirm } = renderDialog();

    expect(
      screen.getByText(/3 issues in this project are still open/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: 'Keep them in this project' })
    ).toBeChecked();
    await userEvent.click(
      screen.getByRole('button', { name: 'Complete project' })
    );

    expect(onConfirm).toHaveBeenCalledWith({ action: 'keep' });
  });

  it('waits on a target before a move and then sends it', async () => {
    const { onConfirm } = renderDialog();

    await userEvent.click(
      screen.getByRole('radio', { name: 'Move them to another project' })
    );
    const confirm = screen.getByRole('button', { name: 'Complete project' });
    expect(confirm).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Move to project' }),
      'prj-2'
    );
    await userEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledWith({
      action: 'move',
      project_id: 'prj-2',
    });
  });

  it('cancels the open issues with a cancel of the project', async () => {
    const { onConfirm } = renderDialog('canceled');

    await userEvent.click(screen.getByRole('radio', { name: 'Cancel them' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel project' })
    );

    expect(onConfirm).toHaveBeenCalledWith({ action: 'cancel' });
  });

  it('does not offer a move with no project to move to', () => {
    renderDialog('completed', []);

    expect(
      screen.getByRole('radio', { name: 'Move them to another project' })
    ).toBeDisabled();
  });

  it('goes back without sending anything', async () => {
    const { onConfirm, onClose } = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('when a close asks about open issues', () => {
  it('counts todo and in progress as open', () => {
    expect(openIssueCount(project())).toBe(3);
  });

  it('asks only on a close of a project with open issues', () => {
    expect(asksAboutOpenIssues(project(), 'completed')).toBe(true);
    expect(asksAboutOpenIssues(project(), 'canceled')).toBe(true);
    expect(asksAboutOpenIssues(project(), 'paused')).toBe(false);
    expect(
      asksAboutOpenIssues(project({ status: 'completed' }), 'completed')
    ).toBe(false);
    expect(
      asksAboutOpenIssues(
        project({
          counts: { todo: 0, in_progress: 0, done: 2, cancelled: 0, total: 2 },
        }),
        'completed'
      )
    ).toBe(false);
  });

  it('offers open projects on every team of the closing one, by name', () => {
    const closing = project({ team_ids: ['team-1', 'team-2'] });
    const candidates = [
      project({
        project_id: 'prj-3',
        name: 'Zeta',
        team_ids: ['team-2', 'team-1', 'team-3'],
      }),
      project({
        project_id: 'prj-4',
        name: 'Alpha',
        team_ids: ['team-1', 'team-2'],
      }),
      project({ project_id: 'prj-5', name: 'Narrow', team_ids: ['team-1'] }),
      project({
        project_id: 'prj-6',
        name: 'Done',
        team_ids: ['team-1', 'team-2'],
        status: 'completed',
      }),
      closing,
    ];

    expect(moveTargets(closing, candidates).map((row) => row.name)).toEqual([
      'Alpha',
      'Zeta',
    ]);
  });
});
