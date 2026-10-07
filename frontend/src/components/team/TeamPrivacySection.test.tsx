/**
 * The team privacy section. Covers that making a team private asks first and
 * only saves on confirm, that a plan refusal shows the server's sentence, that
 * making a team open saves at once, and that a reader sees no switch.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamRead, TeamUpdate } from '../../types/Api';
import TeamPrivacySection from './TeamPrivacySection';

const updateTeam = vi.fn<(body: TeamUpdate) => Promise<TeamRead>>();

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    updateTeam: (_w: string, _t: string, body: TeamUpdate) => updateTeam(body),
  };
});

/** A team in the shape the contract answers with. */
const team = (over: Partial<TeamRead> = {}): TeamRead => ({
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Platform',
  key_prefix: 'PLAT',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  private: false,
  ...over,
});

beforeEach(() => {
  updateTeam.mockReset();
  updateTeam.mockImplementation((body) =>
    Promise.resolve(team({ private: body.private ?? false }))
  );
});

describe('the team privacy section', () => {
  it('asks before making a team private and saves on confirm', async () => {
    const user = userEvent.setup();
    render(
      <TeamPrivacySection workspaceId="ws-1" team={team()} canEdit={true} />
    );

    await user.click(screen.getByRole('button', { name: 'Make private' }));
    expect(updateTeam).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('loses access');

    const confirm = screen
      .getAllByRole('button', { name: 'Make private' })
      .find((button) => dialog.contains(button));
    if (confirm === undefined) throw new Error('no confirm button');
    await user.click(confirm);

    await waitFor(() => {
      expect(updateTeam).toHaveBeenCalledWith({ private: true });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows the plan refusal inside the confirmation', async () => {
    updateTeam.mockRejectedValue(
      new ApiError({
        status: 403,
        statusText: 'Forbidden',
        body: {
          error_code: 'PLAN_FEATURE_UNAVAILABLE',
          message: 'Private teams is not included in the free plan.',
        },
        url: '/api/workspaces/ws-1/teams/team-1',
        method: 'PATCH',
      })
    );
    const user = userEvent.setup();
    render(
      <TeamPrivacySection workspaceId="ws-1" team={team()} canEdit={true} />
    );

    await user.click(screen.getByRole('button', { name: 'Make private' }));
    const dialog = screen.getByRole('dialog');
    const confirm = screen
      .getAllByRole('button', { name: 'Make private' })
      .find((button) => dialog.contains(button));
    if (confirm === undefined) throw new Error('no confirm button');
    await user.click(confirm);

    expect(
      await screen.findByText(/not included in the free plan/)
    ).toBeInTheDocument();
  });

  it('makes a private team open at once', async () => {
    const user = userEvent.setup();
    render(
      <TeamPrivacySection
        workspaceId="ws-1"
        team={team({ private: true })}
        canEdit={true}
      />
    );

    expect(screen.getByText(/This team is private/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make open' }));
    await waitFor(() => {
      expect(updateTeam).toHaveBeenCalledWith({ private: false });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a reader the state without a switch', () => {
    render(
      <TeamPrivacySection
        workspaceId="ws-1"
        team={team({ private: true })}
        canEdit={false}
      />
    );
    expect(screen.getByText(/This team is private/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
