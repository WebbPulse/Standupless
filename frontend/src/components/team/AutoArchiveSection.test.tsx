/**
 * The auto-archive section. Covers a team that never chose a period reading
 * as six months, that picking a period saves it at once and confirms, and
 * that a reader sees the period without being able to change it.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import type {
  ArchiveSettingsRead,
  ArchiveSettingsUpdate,
} from '../../types/Api';
import AutoArchiveSection from './AutoArchiveSection';

const getArchiveSettings = vi.fn<() => Promise<ArchiveSettingsRead>>();
const updateArchiveSettings =
  vi.fn<(body: ArchiveSettingsUpdate) => Promise<ArchiveSettingsRead>>();

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    getArchiveSettings: () => getArchiveSettings(),
    updateArchiveSettings: (
      _w: string,
      _t: string,
      body: ArchiveSettingsUpdate
    ) => updateArchiveSettings(body),
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

/** A setting in the shape the contract answers with, the default first. */
const settings = (
  over: Partial<ArchiveSettingsRead> = {}
): ArchiveSettingsRead => ({
  team_id: 'team-1',
  period_months: 6,
  updated_at: null,
  ...over,
});

const renderSection = (canEdit = true) =>
  render(
    <AutoArchiveSection workspaceId="ws-1" teamId="team-1" canEdit={canEdit} />
  );

beforeEach(() => {
  getArchiveSettings.mockReset();
  updateArchiveSettings.mockReset();
  getArchiveSettings.mockResolvedValue(settings());
  updateArchiveSettings.mockImplementation((body) =>
    Promise.resolve(
      settings({
        period_months: body.period_months ?? 6,
        updated_at: '2026-09-26T00:00:00Z',
      })
    )
  );
});

afterEach(() => {
  act(() => {
    clearToasts();
  });
});

describe('the auto-archive section', () => {
  it('reads a team that never chose a period as six months', async () => {
    renderSection();

    const select = await screen.findByLabelText('Auto-archive closed issues');
    expect(select).toHaveValue('6');
    expect(
      screen.getAllByRole('option').map((option) => option.textContent)
    ).toEqual([
      'After 1 month',
      'After 3 months',
      'After 6 months',
      'After 9 months',
      'After 12 months',
    ]);
  });

  it('saves a new period as soon as it is picked', async () => {
    renderSection();

    const select = await screen.findByLabelText('Auto-archive closed issues');
    getArchiveSettings.mockResolvedValue(settings({ period_months: 3 }));
    await userEvent.selectOptions(select, '3');

    await waitFor(() => {
      expect(updateArchiveSettings).toHaveBeenCalledWith({ period_months: 3 });
    });
    await waitFor(() => {
      expect(currentToasts().map((toast) => toast.message)).toEqual([
        'Auto-archive period saved.',
      ]);
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Auto-archive closed issues')).toHaveValue(
        '3'
      );
    });
  });

  it('shows a reader the period without letting them change it', async () => {
    getArchiveSettings.mockResolvedValue(settings({ period_months: 12 }));
    renderSection(false);

    await waitFor(() => {
      expect(screen.getByLabelText('Auto-archive closed issues')).toHaveValue(
        '12'
      );
    });
    expect(screen.getByLabelText('Auto-archive closed issues')).toBeDisabled();
  });
});
