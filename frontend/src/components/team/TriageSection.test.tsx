/**
 * The triage section. Covers that flipping the switch saves at once, that a
 * plan without triage locks the switch while off and links to the plans,
 * that after a downgrade an admin can still turn triage off, and that the
 * responsibility picks, the action and the priority rule each save at once,
 * with guests left off the duty list.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MemberRead,
  TeamMemberRead,
  TriageSettingsRead,
  TriageSettingsUpdate,
} from '../../types/Api';
import TriageSection from './TriageSection';

const getTriageSettings = vi.fn<() => Promise<TriageSettingsRead>>();
const updateTriageSettings =
  vi.fn<(body: TriageSettingsUpdate) => Promise<TriageSettingsRead>>();

vi.mock('../../api/triage', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/triage')>(
      '../../api/triage'
    );
  return {
    ...actual,
    getTriageSettings: () => getTriageSettings(),
    updateTriageSettings: (
      _w: string,
      _t: string,
      body: TriageSettingsUpdate
    ) => updateTriageSettings(body),
  };
});

const TEAM_MEMBERS: TeamMemberRead[] = [
  {
    user_id: 'u-ada',
    email: 'ada@example.com',
    display_name: 'ada',
    role: 'admin',
    added_at: '2026-01-01T00:00:00Z',
  },
  {
    user_id: 'u-bo',
    email: 'bo@example.com',
    display_name: 'bo',
    role: 'member',
    added_at: '2026-01-01T00:00:00Z',
  },
  {
    user_id: 'u-gus',
    email: 'gus@example.com',
    display_name: 'gus',
    role: 'member',
    added_at: '2026-01-01T00:00:00Z',
  },
];

const WORKSPACE_MEMBERS: MemberRead[] = TEAM_MEMBERS.map((member) => ({
  user_id: member.user_id,
  email: member.email,
  display_name: member.display_name,
  role: member.user_id === 'u-gus' ? 'guest' : 'member',
  joined_at: '2026-01-01T00:00:00Z',
}));

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    listTeamMembers: () => Promise.resolve(TEAM_MEMBERS),
  };
});

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return {
    ...actual,
    listMembers: () => Promise.resolve(WORKSPACE_MEMBERS),
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

/** A triage setting in the shape the contract answers with. */
const setting = (
  enabled: boolean,
  extra: Partial<TriageSettingsRead> = {}
): TriageSettingsRead => ({
  team_id: 'team-1',
  enabled,
  responsible_user_ids: [],
  responsibility_action: 'notify',
  require_priority: false,
  updated_at: null,
  ...extra,
});

/** Renders the section inside a router, on or off the plan. */
const renderSection = (planIncluded: boolean) =>
  render(
    <MemoryRouter>
      <TriageSection
        workspaceId="ws-1"
        teamId="team-1"
        canEdit={true}
        planIncluded={planIncluded}
        slug="acme"
      />
    </MemoryRouter>
  );

beforeEach(() => {
  getTriageSettings.mockReset();
  updateTriageSettings.mockReset();
  getTriageSettings.mockResolvedValue(setting(false));
  updateTriageSettings.mockImplementation((body) =>
    Promise.resolve(setting(body.enabled ?? false))
  );
});

describe('TriageSection', () => {
  it('on a plan with triage turns it on at once', async () => {
    const user = userEvent.setup();
    renderSection(true);

    const toggle = await screen.findByRole('switch', {
      name: 'Use a triage inbox',
    });
    expect(screen.queryByText(/needs the Standard plan/)).toBeNull();
    await user.click(toggle);

    await waitFor(() => {
      expect(updateTriageSettings).toHaveBeenCalledWith({ enabled: true });
    });
  });

  it('on a plan without triage locks the switch and links to the plans', async () => {
    renderSection(false);

    const toggle = await screen.findByRole('switch', {
      name: 'Use a triage inbox',
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(/Triage needs the Standard plan/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute(
      'href',
      '/w/acme/settings/billing'
    );
  });

  it('after a downgrade still lets an admin turn triage off', async () => {
    getTriageSettings.mockResolvedValue(setting(true));
    const user = userEvent.setup();
    renderSection(false);

    const toggle = await screen.findByRole('switch', {
      name: 'Use a triage inbox',
    });
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
    expect(toggle).toBeEnabled();
    await user.click(toggle);

    await waitFor(() => {
      expect(updateTriageSettings).toHaveBeenCalledWith({ enabled: false });
    });
  });

  it('keeps responsibility hidden while triage is off', async () => {
    renderSection(true);
    await screen.findByRole('switch', { name: 'Use a triage inbox' });
    expect(screen.queryByText('Responsibility')).toBeNull();
    expect(
      screen.queryByRole('switch', {
        name: 'Require priority before leaving triage',
      })
    ).toBeNull();
  });

  it('puts a member on duty and leaves guests off the list', async () => {
    getTriageSettings.mockResolvedValue(
      setting(true, { responsible_user_ids: ['u-ada'] })
    );
    const user = userEvent.setup();
    renderSection(true);

    const bo = await screen.findByRole('checkbox', { name: 'bo' });
    expect(screen.getByRole('checkbox', { name: 'ada' })).toBeChecked();
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: 'gus' })).toBeNull();
    });
    await user.click(bo);

    await waitFor(() => {
      expect(updateTriageSettings).toHaveBeenCalledWith({
        responsible_user_ids: ['u-ada', 'u-bo'],
      });
    });
  });

  it('takes a member off duty', async () => {
    getTriageSettings.mockResolvedValue(
      setting(true, { responsible_user_ids: ['u-ada', 'u-bo'] })
    );
    const user = userEvent.setup();
    renderSection(true);

    await user.click(await screen.findByRole('checkbox', { name: 'ada' }));

    await waitFor(() => {
      expect(updateTriageSettings).toHaveBeenCalledWith({
        responsible_user_ids: ['u-bo'],
      });
    });
  });

  it('switches the action to assign round robin', async () => {
    getTriageSettings.mockResolvedValue(setting(true));
    const user = userEvent.setup();
    renderSection(true);

    const select = await screen.findByLabelText('When an issue enters triage');
    expect(select).toHaveValue('notify');
    await user.selectOptions(select, 'assign');

    await waitFor(() => {
      expect(updateTriageSettings).toHaveBeenCalledWith({
        responsibility_action: 'assign',
      });
    });
  });

  it('turns on the priority rule', async () => {
    getTriageSettings.mockResolvedValue(setting(true));
    const user = userEvent.setup();
    renderSection(true);

    const toggle = await screen.findByRole('switch', {
      name: 'Require priority before leaving triage',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);

    await waitFor(() => {
      expect(updateTriageSettings).toHaveBeenCalledWith({
        require_priority: true,
      });
    });
  });
});
