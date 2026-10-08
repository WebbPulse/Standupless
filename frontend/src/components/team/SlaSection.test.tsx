/**
 * The SLA section. Covers a team that never saved reading as off with a day
 * for urgent and three days for high, that flipping the switch and picking an
 * hours choice each save at once and confirm, that a stored value off the
 * list still shows, and that a reader sees the rules without changing them.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import type { SlaSettingsRead, SlaSettingsUpdate } from '../../types/Api';
import SlaSection from './SlaSection';

const getSlaSettings = vi.fn<() => Promise<SlaSettingsRead>>();
const updateSlaSettings =
  vi.fn<(body: SlaSettingsUpdate) => Promise<SlaSettingsRead>>();

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    getSlaSettings: () => getSlaSettings(),
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
  updated_at: null,
  ...over,
});

const renderSection = (canEdit = true) =>
  render(<SlaSection workspaceId="ws-1" teamId="team-1" canEdit={canEdit} />);

beforeEach(() => {
  getSlaSettings.mockReset();
  updateSlaSettings.mockReset();
  getSlaSettings.mockResolvedValue(settings());
  updateSlaSettings.mockImplementation((body) =>
    Promise.resolve(settings({ ...body, updated_at: '2026-10-07T00:00:00Z' }))
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
  });
});
