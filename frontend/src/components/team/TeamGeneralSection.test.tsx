/**
 * The team General section's estimate settings. Covers that the three toggles
 * show beside a scale that is on and hide when estimates are off, that saving
 * sends them with the scale, and that the extended toggle names the values it
 * adds for the chosen scale, and that a sub-team links to its parent's
 * settings for them.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamRead, TeamUpdate } from '../../types/Api';
import TeamGeneralSection from './TeamGeneralSection';

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
  estimate_scale: 'tshirt',
  estimate_extended: false,
  estimate_allow_zero: false,
  estimate_count_unestimated: false,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

/** Renders the section for a team admin, under a parent's settings page when given. */
const renderSection = (value: TeamRead, parentSettingsPath?: string): void => {
  render(
    <MemoryRouter>
      <TeamGeneralSection
        workspaceId="ws-1"
        team={value}
        canEdit={true}
        parentSettingsPath={parentSettingsPath}
      />
    </MemoryRouter>
  );
};

beforeEach(() => {
  updateTeam.mockReset();
  updateTeam.mockResolvedValue(team());
});

describe('the team estimate settings', () => {
  it('saves the extended, zero and unestimated toggles with the scale', async () => {
    const user = userEvent.setup();
    renderSection(team());

    await user.selectOptions(screen.getByLabelText('Estimates'), 'exponential');
    await user.click(
      screen.getByRole('checkbox', { name: /Extended range: add 32 and 64/ })
    );
    await user.click(screen.getByRole('checkbox', { name: /Allow zero/ }));
    await user.click(
      screen.getByRole('checkbox', { name: /Count unestimated issues/ })
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          estimate_scale: 'exponential',
          estimate_extended: true,
          estimate_allow_zero: true,
          estimate_count_unestimated: true,
        })
      );
    });
  });

  it('starts from the stored toggles and names the T-shirt extension', () => {
    renderSection(team({ estimate_extended: true }));

    expect(
      screen.getByRole('checkbox', { name: /add XXL and XXXL/ })
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /Allow zero/ })
    ).not.toBeChecked();
  });

  it('hides the toggles while estimates are off', () => {
    renderSection(team({ estimate_scale: 'off' }));

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('links a sub-team to the estimates in its parent team settings', () => {
    renderSection(
      team({ parent_team_id: 'team-0' }),
      '/w/acme/team/ENG/settings'
    );

    expect(
      screen.getByRole('link', { name: "parent team's settings" })
    ).toHaveAttribute(
      'href',
      '/w/acme/team/ENG/settings#team-settings-general'
    );
  });
});
