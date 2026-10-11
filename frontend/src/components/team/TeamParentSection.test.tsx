/**
 * The parent team section. Covers that only top-level teams are offered, that
 * picking one and clearing it saves at once, that a team with sub-teams cannot
 * take a parent, that a reader sees no picker, and that a top-level team offers
 * "Create sub-team" with itself as the parent.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateTeamContext,
  type CreateTeamState,
} from '../../hooks/useCreateTeam';
import type { TeamRead, TeamUpdate } from '../../types/Api';
import TeamParentSection from './TeamParentSection';

const updateTeam = vi.fn<(body: TeamUpdate) => Promise<TeamRead>>();

let listed: TeamRead[] = [];

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    updateTeam: (_w: string, _t: string, body: TeamUpdate) => updateTeam(body),
  };
});

vi.mock('../../hooks/useTeams', () => ({
  useTeamsFor: (workspaceId: string) => ({
    data: listed,
    isLoading: false,
    error: null,
    refetch: () => Promise.resolve(),
    workspaceId,
  }),
}));

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
  parent_team_id: null,
  ...over,
});

const own = team();
const engineering = team({
  id: 'team-2',
  name: 'Engineering',
  key_prefix: 'ENG',
});
const mobile = team({
  id: 'team-3',
  name: 'Mobile',
  key_prefix: 'MOB',
  parent_team_id: 'team-2',
});

beforeEach(() => {
  listed = [own, engineering, mobile];
  updateTeam.mockReset();
  updateTeam.mockResolvedValue(own);
});

describe('the parent team section', () => {
  it('offers only other top-level teams and saves the pick', async () => {
    const user = userEvent.setup();
    render(<TeamParentSection workspaceId="ws-1" team={own} canEdit={true} />);

    const picker = screen.getByRole('combobox', { name: 'Parent team' });
    const options = Array.from(
      picker.querySelectorAll('option'),
      (option) => option.textContent
    );
    expect(options).toEqual(['No parent team', 'Engineering']);

    await user.selectOptions(picker, 'team-2');
    await waitFor(() => {
      expect(updateTeam).toHaveBeenCalledWith({ parent_team_id: 'team-2' });
    });
  });

  it('clears the parent of a sub-team', async () => {
    const user = userEvent.setup();
    render(
      <TeamParentSection workspaceId="ws-1" team={mobile} canEdit={true} />
    );

    expect(screen.getByText(/sits under Engineering/)).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Parent team' }),
      ''
    );
    await waitFor(() => {
      expect(updateTeam).toHaveBeenCalledWith({ parent_team_id: null });
    });
  });

  it('keeps a team with sub-teams top-level', () => {
    render(
      <TeamParentSection workspaceId="ws-1" team={engineering} canEdit={true} />
    );

    expect(screen.getByText(/Sub-teams: Mobile/)).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Parent team' })
    ).toBeDisabled();
  });

  it('shows a reader no picker', () => {
    render(<TeamParentSection workspaceId="ws-1" team={own} canEdit={false} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/top-level/)).toBeInTheDocument();
  });

  it('creates a sub-team of a top-level team from its settings', async () => {
    const user = userEvent.setup();
    const openSubTeam = vi.fn();
    const dialog: CreateTeamState = {
      open: vi.fn(),
      openSubTeam,
      canCreate: true,
    };
    render(
      <CreateTeamContext.Provider value={dialog}>
        <TeamParentSection workspaceId="ws-1" team={own} canEdit={false} />
      </CreateTeamContext.Provider>
    );

    await user.click(screen.getByRole('button', { name: 'Create sub-team' }));

    expect(openSubTeam).toHaveBeenCalledWith('team-1');
  });

  it('offers a sub-team no Create sub-team', () => {
    const dialog: CreateTeamState = {
      open: vi.fn(),
      openSubTeam: vi.fn(),
      canCreate: true,
    };
    render(
      <CreateTeamContext.Provider value={dialog}>
        <TeamParentSection workspaceId="ws-1" team={mobile} canEdit={true} />
      </CreateTeamContext.Provider>
    );

    expect(
      screen.queryByRole('button', { name: 'Create sub-team' })
    ).not.toBeInTheDocument();
  });
});
