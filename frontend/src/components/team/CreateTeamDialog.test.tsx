/**
 * The create team dialog: the key it derives from the name until the person
 * edits it, the key rules the create route enforces, the sentence a taken key
 * gets, and the follow-up write that carries a description the create route
 * has no field for.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamRead } from '../../types/Api';
import CreateTeamDialog from './CreateTeamDialog';

const createTeam = vi.fn<(body: unknown) => Promise<TeamRead>>();
const updateTeam = vi.fn<(body: unknown) => Promise<TeamRead>>();

vi.mock('../../api/teams', () => ({
  createTeam: (_w: string, body: unknown) => createTeam(body),
  updateTeam: (_w: string, _t: string, body: unknown) => updateTeam(body),
}));

/** The team the create route answers with. */
const created: TeamRead = {
  id: 'team-9',
  workspace_id: 'ws-1',
  name: 'Platform',
  key_prefix: 'PLAT',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
  role: 'admin',
};

/** Renders the dialog with spies for its callbacks. */
const renderDialog = () => {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <CreateTeamDialog
      workspaceId="ws-1"
      onClose={onClose}
      onCreated={onCreated}
    />
  );
  return { user, onCreated, onClose };
};

beforeEach(() => {
  createTeam.mockReset();
  updateTeam.mockReset();
});

describe('the key', () => {
  it('derives from the name while the person has not edited it', async () => {
    const { user } = renderDialog();

    await user.type(screen.getByLabelText('Name'), 'Platform core');

    expect(screen.getByLabelText('Key')).toHaveValue('PC');
  });

  it('stops following the name once edited, and uppercases what is typed', async () => {
    const { user } = renderDialog();

    await user.type(screen.getByLabelText('Name'), 'Platform');
    await user.clear(screen.getByLabelText('Key'));
    await user.type(screen.getByLabelText('Key'), 'plt');
    await user.type(screen.getByLabelText('Name'), ' team');

    expect(screen.getByLabelText('Key')).toHaveValue('PLT');
  });

  it('refuses a key the create route would refuse', async () => {
    const { user } = renderDialog();

    await user.type(screen.getByLabelText('Name'), 'Platform');
    await user.clear(screen.getByLabelText('Key'));
    await user.type(screen.getByLabelText('Key'), '1A');

    expect(screen.getByLabelText('Key')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByText(/uppercase letter, then/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create team' })).toBeDisabled();
  });

  it('refuses a one letter key', async () => {
    const { user } = renderDialog();

    await user.type(screen.getByLabelText('Name'), 'A');

    expect(screen.getByRole('button', { name: 'Create team' })).toBeDisabled();
  });
});

describe('submitting', () => {
  it('stays disabled until there is a name', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Create team' })).toBeDisabled();
  });

  it('creates the team and hands it back', async () => {
    createTeam.mockResolvedValue(created);
    const { user, onCreated } = renderDialog();

    await user.type(screen.getByLabelText('Name'), 'Platform');
    await user.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(created);
    });
    expect(createTeam).toHaveBeenCalledWith({
      name: 'Platform',
      key_prefix: 'PLA',
      estimate_scale: 'off',
    });
    expect(updateTeam).not.toHaveBeenCalled();
  });

  it('writes a description with a follow-up update, since create has no field for it', async () => {
    createTeam.mockResolvedValue(created);
    updateTeam.mockResolvedValue({ ...created, description: 'Infra' });
    const { user, onCreated } = renderDialog();

    await user.type(screen.getByLabelText('Name'), 'Platform');
    await user.type(screen.getByLabelText('Description (optional)'), 'Infra');
    await user.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() => {
      expect(updateTeam).toHaveBeenCalledWith({ description: 'Infra' });
    });
    expect(onCreated).toHaveBeenCalledWith({
      ...created,
      description: 'Infra',
    });
  });

  it('names a key another team already holds', async () => {
    createTeam.mockRejectedValue(
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: null,
        url: '/api/workspaces/ws-1/teams',
        method: 'POST',
      })
    );
    const { user, onCreated } = renderDialog();

    await user.type(screen.getByLabelText('Name'), 'Platform');
    await user.click(screen.getByRole('button', { name: 'Create team' }));

    expect(
      await screen.findByText(
        'Another team already uses PLA. Pick a different key.'
      )
    ).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
