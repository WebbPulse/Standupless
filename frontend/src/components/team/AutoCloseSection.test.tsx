/**
 * The auto-close section. Covers a team that never chose a period reading as
 * off with no status choice, that picking a period saves it at once, that the
 * status choice lists only canceled statuses and saves, and that a reader sees
 * the setting without being able to change it.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import type {
  AutoCloseSettingsRead,
  AutoCloseSettingsUpdate,
  StatusRead,
} from '../../types/Api';
import AutoCloseSection from './AutoCloseSection';

const getAutoCloseSettings = vi.fn<() => Promise<AutoCloseSettingsRead>>();
const updateAutoCloseSettings =
  vi.fn<(body: AutoCloseSettingsUpdate) => Promise<AutoCloseSettingsRead>>();

const STATUSES: StatusRead[] = [
  { id: 'st-backlog', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 'st-done', name: 'Done', category: 'completed', position: 1 },
  { id: 'st-canceled', name: 'Canceled', category: 'cancelled', position: 2 },
  { id: 'st-dup', name: 'Duplicate', category: 'cancelled', position: 3 },
];

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    getAutoCloseSettings: () => getAutoCloseSettings(),
    listStatuses: () => Promise.resolve(STATUSES),
    updateAutoCloseSettings: (
      _w: string,
      _t: string,
      body: AutoCloseSettingsUpdate
    ) => updateAutoCloseSettings(body),
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

/** A setting in the shape the contract answers with, off by default. */
const settings = (
  over: Partial<AutoCloseSettingsRead> = {}
): AutoCloseSettingsRead => ({
  team_id: 'team-1',
  enabled: false,
  period_months: null,
  status_id: null,
  updated_at: null,
  ...over,
});

const renderSection = (canEdit = true) =>
  render(
    <AutoCloseSection workspaceId="ws-1" teamId="team-1" canEdit={canEdit} />
  );

beforeEach(() => {
  getAutoCloseSettings.mockReset();
  updateAutoCloseSettings.mockReset();
  getAutoCloseSettings.mockResolvedValue(settings());
  updateAutoCloseSettings.mockImplementation((body) =>
    Promise.resolve(
      settings({
        enabled: body.period_months != null,
        period_months: body.period_months ?? null,
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

describe('the auto-close section', () => {
  it('reads a team that never chose a period as off', async () => {
    renderSection();

    const select = await screen.findByLabelText('Auto-close stale issues');
    expect(select).toHaveValue('off');
    expect(
      screen.getAllByRole('option').map((option) => option.textContent)
    ).toEqual([
      'Off',
      'After 1 month',
      'After 3 months',
      'After 6 months',
      'After 9 months',
      'After 12 months',
    ]);
    expect(screen.queryByLabelText('Close into')).not.toBeInTheDocument();
  });

  it('saves a new period as soon as it is picked', async () => {
    renderSection();

    const select = await screen.findByLabelText('Auto-close stale issues');
    getAutoCloseSettings.mockResolvedValue(
      settings({ enabled: true, period_months: 3 })
    );
    await userEvent.selectOptions(select, '3');

    await waitFor(() => {
      expect(updateAutoCloseSettings).toHaveBeenCalledWith({
        period_months: 3,
      });
    });
    await waitFor(() => {
      expect(currentToasts().map((toast) => toast.message)).toEqual([
        'Auto-close period saved.',
      ]);
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Auto-close stale issues')).toHaveValue(
        '3'
      );
    });
  });

  it('offers only canceled statuses and saves the one picked', async () => {
    getAutoCloseSettings.mockResolvedValue(
      settings({ enabled: true, period_months: 6 })
    );
    renderSection();

    const select = await screen.findByLabelText('Close into');
    await waitFor(() => {
      expect(
        Array.from(select.querySelectorAll('option')).map(
          (option) => option.textContent
        )
      ).toEqual(['First canceled status', 'Canceled', 'Duplicate']);
    });
    await userEvent.selectOptions(select, 'st-dup');

    await waitFor(() => {
      expect(updateAutoCloseSettings).toHaveBeenCalledWith({
        status_id: 'st-dup',
      });
    });
  });

  it('shows a reader the setting without letting them change it', async () => {
    getAutoCloseSettings.mockResolvedValue(
      settings({ enabled: true, period_months: 12, status_id: 'st-canceled' })
    );
    renderSection(false);

    await waitFor(() => {
      expect(screen.getByLabelText('Auto-close stale issues')).toHaveValue(
        '12'
      );
    });
    expect(screen.getByLabelText('Auto-close stale issues')).toBeDisabled();
    expect(screen.getByLabelText('Close into')).toBeDisabled();
  });
});
