/**
 * The parent and sub-issue auto-close section. Covers a team that never chose
 * reading both switches as off, that flipping a switch saves only that field at
 * once, and that a reader sees the settings without being able to change them.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import type {
  ParentAutoCloseSettingsRead,
  ParentAutoCloseSettingsUpdate,
} from '../../types/Api';
import ParentAutoCloseSection from './ParentAutoCloseSection';

const getParentAutoCloseSettings =
  vi.fn<() => Promise<ParentAutoCloseSettingsRead>>();
const updateParentAutoCloseSettings =
  vi.fn<
    (
      body: ParentAutoCloseSettingsUpdate
    ) => Promise<ParentAutoCloseSettingsRead>
  >();

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    getParentAutoCloseSettings: () => getParentAutoCloseSettings(),
    updateParentAutoCloseSettings: (
      _w: string,
      _t: string,
      body: ParentAutoCloseSettingsUpdate
    ) => updateParentAutoCloseSettings(body),
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

/** Settings in the shape the contract answers with, both off by default. */
const settings = (
  over: Partial<ParentAutoCloseSettingsRead> = {}
): ParentAutoCloseSettingsRead => ({
  team_id: 'team-1',
  close_parent: false,
  close_sub_issues: false,
  updated_at: null,
  ...over,
});

const renderSection = (canEdit = true) =>
  render(
    <ParentAutoCloseSection
      workspaceId="ws-1"
      teamId="team-1"
      canEdit={canEdit}
    />
  );

beforeEach(() => {
  getParentAutoCloseSettings.mockReset();
  updateParentAutoCloseSettings.mockReset();
  getParentAutoCloseSettings.mockResolvedValue(settings());
  updateParentAutoCloseSettings.mockImplementation((body) =>
    Promise.resolve(settings({ ...body, updated_at: '2026-10-25T00:00:00Z' }))
  );
});

afterEach(() => {
  act(() => {
    clearToasts();
  });
});

describe('the parent and sub-issue auto-close section', () => {
  it('reads a team that never chose as both switches off', async () => {
    renderSection();

    const parent = await screen.findByRole('switch', {
      name: 'Auto-close parent issues',
    });
    expect(parent).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByRole('switch', { name: 'Auto-close sub-issues' })
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('saves only the switch that was flipped', async () => {
    renderSection();

    const parent = await screen.findByRole('switch', {
      name: 'Auto-close parent issues',
    });
    getParentAutoCloseSettings.mockResolvedValue(
      settings({ close_parent: true })
    );
    await userEvent.click(parent);

    await waitFor(() => {
      expect(updateParentAutoCloseSettings).toHaveBeenCalledWith({
        close_parent: true,
      });
    });
    await waitFor(() => {
      expect(currentToasts().map((toast) => toast.message)).toEqual([
        'Parent issues now close with their sub-issues.',
      ]);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Auto-close parent issues' })
      ).toHaveAttribute('aria-checked', 'true');
    });
    expect(
      screen.getByRole('switch', { name: 'Auto-close sub-issues' })
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('shows a reader the settings without letting them change them', async () => {
    getParentAutoCloseSettings.mockResolvedValue(
      settings({ close_sub_issues: true })
    );
    renderSection(false);

    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Auto-close sub-issues' })
      ).toHaveAttribute('aria-checked', 'true');
    });
    expect(
      screen.getByRole('switch', { name: 'Auto-close sub-issues' })
    ).toBeDisabled();
    expect(
      screen.getByRole('switch', { name: 'Auto-close parent issues' })
    ).toBeDisabled();
  });
});
