/**
 * The SLA section. Covers a team that never saved reading as off with a day
 * for urgent and three days for high, that flipping the switch and picking an
 * hours choice each save at once and confirm, that a stored value off the
 * list still shows, that a reader sees the rules without changing them, and
 * that ticking an open status adds it to the paused set while finished
 * statuses are not offered.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import type {
  SlaSettingsRead,
  SlaSettingsUpdate,
  StatusRead,
} from '../../types/Api';
import SlaSection from './SlaSection';

const getSlaSettings = vi.fn<() => Promise<SlaSettingsRead>>();
const updateSlaSettings =
  vi.fn<(body: SlaSettingsUpdate) => Promise<SlaSettingsRead>>();

const STATUSES: StatusRead[] = [
  { id: 'st-backlog', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 'st-progress', name: 'In Progress', category: 'started', position: 1 },
  { id: 'st-staging', name: 'On Staging', category: 'started', position: 2 },
  { id: 'st-done', name: 'Done', category: 'completed', position: 3 },
  { id: 'st-canceled', name: 'Canceled', category: 'cancelled', position: 4 },
];

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    getSlaSettings: () => getSlaSettings(),
    listStatuses: () => Promise.resolve(STATUSES),
    updateSlaSettings: (_w: string, _t: string, body: SlaSettingsUpdate) =>
      updateSlaSettings(body),
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

/** Rules in the shape the contract answers with, the defaults first. */
const settings = (over: Partial<SlaSettingsRead> = {}): SlaSettingsRead => ({
  team_id: 'team-1',
  enabled: false,
  urgent_hours: 24,
  high_hours: 72,
  medium_hours: null,
  low_hours: null,
  paused_status_ids: [],
  updated_at: null,
  ...over,
});

const renderSection = (canEdit = true) =>
  render(<SlaSection workspaceId="ws-1" teamId="team-1" canEdit={canEdit} />);

beforeEach(() => {
  getSlaSettings.mockReset();
  updateSlaSettings.mockReset();
  getSlaSettings.mockResolvedValue(settings());
  updateSlaSettings.mockImplementation(({ paused_status_ids, ...body }) =>
    Promise.resolve(
      settings({
        ...body,
        paused_status_ids: paused_status_ids ?? [],
        updated_at: '2026-10-07T00:00:00Z',
      })
    )
  );
});

afterEach(() => {
  act(() => {
    clearToasts();
  });
});

describe('the SLA section', () => {
  it('reads a team that never saved as the default rules', async () => {
    renderSection();

    const toggle = await screen.findByRole('switch', { name: 'Use SLAs' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Urgent')).toHaveValue('24');
    expect(screen.getByLabelText('High')).toHaveValue('72');
    expect(screen.getByLabelText('Medium')).toHaveValue('off');
    expect(screen.getByLabelText('Low')).toHaveValue('off');
    const urgent = screen.getByLabelText<HTMLSelectElement>('Urgent');
    expect(
      Array.from(urgent.options).map((option) => option.textContent)
    ).toEqual([
      'Off',
      '4 hours',
      '8 hours',
      '12 hours',
      '1 day',
      '2 days',
      '3 days',
      '5 days',
      '1 week',
      '2 weeks',
    ]);
  });

  it('turns SLAs on as soon as the switch is flipped', async () => {
    renderSection();

    const toggle = await screen.findByRole('switch', { name: 'Use SLAs' });
    getSlaSettings.mockResolvedValue(settings({ enabled: true }));
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(updateSlaSettings).toHaveBeenCalledWith({ enabled: true });
    });
    await waitFor(() => {
      expect(currentToasts().map((toast) => toast.message)).toEqual([
        'SLAs turned on.',
      ]);
    });
  });

  it('saves one priority as soon as its choice is picked', async () => {
    renderSection();

    const medium = await screen.findByLabelText('Medium');
    getSlaSettings.mockResolvedValue(settings({ medium_hours: 120 }));
    await userEvent.selectOptions(medium, '120');

    await waitFor(() => {
      expect(updateSlaSettings).toHaveBeenCalledWith({ medium_hours: 120 });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Medium')).toHaveValue('120');
    });

    getSlaSettings.mockResolvedValue(settings({ medium_hours: 120 }));
    await userEvent.selectOptions(screen.getByLabelText('Urgent'), 'off');
    await waitFor(() => {
      expect(updateSlaSettings).toHaveBeenCalledWith({ urgent_hours: null });
    });
  });

  it('pauses in a ticked open status and offers no finished ones', async () => {
    renderSection();

    const staging = await screen.findByRole('checkbox', { name: 'On Staging' });
    expect(staging).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Backlog' })).toBeEnabled();
    expect(
      screen.queryByRole('checkbox', { name: 'Done' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Canceled' })
    ).not.toBeInTheDocument();

    getSlaSettings.mockResolvedValue(
      settings({ paused_status_ids: ['st-staging'] })
    );
    await userEvent.click(staging);

    await waitFor(() => {
      expect(updateSlaSettings).toHaveBeenCalledWith({
        paused_status_ids: ['st-staging'],
      });
    });
    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: 'On Staging' })
      ).toBeChecked();
    });
    expect(currentToasts().map((toast) => toast.message)).toContain(
      'SLA timer pauses in that status.'
    );
  });

  it('unticks a paused status and keeps the rest of the set', async () => {
    getSlaSettings.mockResolvedValue(
      settings({ paused_status_ids: ['st-backlog', 'st-staging'] })
    );
    renderSection();

    const staging = await screen.findByRole('checkbox', { name: 'On Staging' });
    await waitFor(() => {
      expect(staging).toBeChecked();
    });
    await userEvent.click(staging);

    await waitFor(() => {
      expect(updateSlaSettings).toHaveBeenCalledWith({
        paused_status_ids: ['st-backlog'],
      });
    });
  });

  it('keeps a stored value that is off the list', async () => {
    getSlaSettings.mockResolvedValue(settings({ low_hours: 30 }));
    renderSection();

    await waitFor(() => {
      expect(screen.getByLabelText('Low')).toHaveValue('30');
    });
    expect(
      screen.getByRole('option', { name: '1 day 6 hours' })
    ).toBeInTheDocument();
  });

  it('shows a reader the rules without letting them edit', async () => {
    getSlaSettings.mockResolvedValue(
      settings({ enabled: true, urgent_hours: 4 })
    );
    renderSection(false);

    await waitFor(() => {
      expect(screen.getByLabelText('Urgent')).toHaveValue('4');
    });
    expect(screen.getByLabelText('Urgent')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Use SLAs' })).toBeDisabled();
    expect(
      await screen.findByRole('checkbox', { name: 'On Staging' })
    ).toBeDisabled();
  });

  it('on a plan without SLAs locks the rules and links to the plans', async () => {
    render(
      <MemoryRouter>
        <SlaSection
          workspaceId="ws-1"
          teamId="team-1"
          canEdit={true}
          planIncluded={false}
          slug="acme"
        />
      </MemoryRouter>
    );

    const toggle = await screen.findByRole('switch', { name: 'Use SLAs' });
    expect(toggle).toBeDisabled();
    expect(screen.getByLabelText('Urgent')).toBeDisabled();
    expect(
      screen.getByText(/SLAs needs the Business plan/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute(
      'href',
      '/w/acme/settings/billing'
    );
  });

  it('after a downgrade still lets an admin turn SLAs off', async () => {
    getSlaSettings.mockResolvedValue(settings({ enabled: true }));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SlaSection
          workspaceId="ws-1"
          teamId="team-1"
          canEdit={true}
          planIncluded={false}
          slug="acme"
        />
      </MemoryRouter>
    );

    const toggle = await screen.findByRole('switch', { name: 'Use SLAs' });
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
    expect(toggle).toBeEnabled();
    await user.click(toggle);

    await waitFor(() => {
      expect(updateSlaSettings).toHaveBeenCalledWith({ enabled: false });
    });
  });
});
