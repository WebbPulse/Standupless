/**
 * The cycles section. Covers a team that never set a schedule reading as the
 * defaults with cycles off, that turning cycles on reveals the schedule and
 * its preview, that saving patches only what changed and refreshes the cycle
 * lists, and that a reader sees the schedule without being able to change it.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import type { CycleSettingsRead, CycleSettingsUpdate } from '../../types/Api';
import CyclesSection from './CyclesSection';

const getCycleSettings = vi.fn<() => Promise<CycleSettingsRead>>();
const updateCycleSettings =
  vi.fn<(body: CycleSettingsUpdate) => Promise<CycleSettingsRead>>();
const invalidated: unknown[] = [];

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    getCycleSettings: () => getCycleSettings(),
    updateCycleSettings: (_w: string, _t: string, body: CycleSettingsUpdate) =>
      updateCycleSettings(body),
  };
});

vi.mock('@webbpulse/api-client/react', async () => {
  const actual = await vi.importActual<
    typeof import('@webbpulse/api-client/react')
  >('@webbpulse/api-client/react');
  return {
    ...actual,
    useMutationWithRefetch: <TArgs extends unknown[], TResult>(
      write: (...args: TArgs) => Promise<TResult>,
      keys: unknown
    ) =>
      actual.useMutationWithRefetch(
        async (...args: TArgs) => {
          const result = await write(...args);
          invalidated.push(keys);
          return result;
        },
        keys as Parameters<typeof actual.useMutationWithRefetch>[1]
      ),
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

/** A schedule in the shape the contract answers with, defaults first. */
const settings = (
  over: Partial<CycleSettingsRead> = {}
): CycleSettingsRead => ({
  team_id: 'team-1',
  enabled: false,
  duration_weeks: 2,
  cooldown_weeks: 0,
  start_weekday: 0,
  upcoming_count: 2,
  auto_add_started: true,
  move_unfinished: true,
  updated_at: null,
  ...over,
});

const renderSection = (canEdit = true) =>
  render(
    <CyclesSection workspaceId="ws-1" teamId="team-1" canEdit={canEdit} />
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 26, 12));
  getCycleSettings.mockReset();
  updateCycleSettings.mockReset();
  invalidated.length = 0;
  getCycleSettings.mockResolvedValue(settings());
  updateCycleSettings.mockImplementation((body) =>
    Promise.resolve(settings({ ...body, updated_at: '2026-09-26T00:00:00Z' }))
  );
});

afterEach(() => {
  vi.useRealTimers();
  act(() => {
    clearToasts();
  });
});

describe('the cycles section', () => {
  it('reads a team that never set a schedule as cycles off', async () => {
    renderSection();

    const toggle = await screen.findByRole('switch', { name: 'Enable cycles' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('Cycle length')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cycle-preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('reveals the schedule with its defaults when cycles are turned on', async () => {
    renderSection();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Enable cycles' })
    );

    expect(screen.getByLabelText('Cycle length')).toHaveValue('2');
    expect(screen.getByLabelText('Cooldown')).toHaveValue('0');
    expect(
      screen.getByRole('option', { name: 'No cooldown' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Cycle start day')).toHaveValue('0');
    expect(
      screen.getAllByRole('option').find((o) => o.textContent === 'Monday')
    ).toBeDefined();
    expect(screen.getByLabelText('Upcoming cycles')).toHaveValue('2');
    expect(
      screen.getByRole('switch', { name: 'Auto-add started issues' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('cycle-preview')).toHaveTextContent(
      'Preview: next cycle starts Mon, Sep 28 and ends Sun, Oct 11.'
    );
  });

  it('updates the preview as the draft changes', async () => {
    renderSection();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Enable cycles' })
    );
    await userEvent.selectOptions(screen.getByLabelText('Cycle length'), '1');
    await userEvent.selectOptions(
      screen.getByLabelText('Cycle start day'),
      '2'
    );
    await userEvent.selectOptions(screen.getByLabelText('Cooldown'), '1');

    expect(screen.getByTestId('cycle-preview')).toHaveTextContent(
      'Preview: next cycle starts Wed, Sep 30 and ends Tue, Oct 6, then a 1 week cooldown.'
    );
  });

  it('patches only what changed and refreshes the cycle lists', async () => {
    renderSection();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Enable cycles' })
    );
    await userEvent.selectOptions(screen.getByLabelText('Cycle length'), '3');
    await userEvent.click(
      screen.getByRole('switch', { name: 'Auto-add started issues' })
    );
    getCycleSettings.mockResolvedValue(
      settings({ enabled: true, duration_weeks: 3, auto_add_started: false })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateCycleSettings).toHaveBeenCalledWith({
        enabled: true,
        duration_weeks: 3,
        auto_add_started: false,
      });
    });
    expect(invalidated).toEqual([
      [
        ['cycle-settings', 'ws-1', 'team-1'],
        ['cycles', 'ws-1', 'team-1', ''],
        ['cycleVelocity', 'ws-1', 'team-1'],
        ['planning-options', 'team-1'],
      ],
    ]);
    await waitFor(() => {
      expect(currentToasts().map((toast) => toast.message)).toEqual([
        'Cycle settings saved. Upcoming cycles are scheduled.',
      ]);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
    expect(screen.getByLabelText('Cycle length')).toHaveValue('3');
  });

  it('turns moving unfinished issues off', async () => {
    getCycleSettings.mockResolvedValue(settings({ enabled: true }));
    renderSection();

    const toggle = await screen.findByRole('switch', {
      name: 'Move unfinished issues to the next cycle',
    });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateCycleSettings).toHaveBeenCalledWith({
        move_unfinished: false,
      });
    });
  });

  it('throws a draft away on discard', async () => {
    renderSection();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Enable cycles' })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(
      screen.getByRole('switch', { name: 'Enable cycles' })
    ).toHaveAttribute('aria-checked', 'false');
    expect(updateCycleSettings).not.toHaveBeenCalled();
  });

  it('shows the server refusal when a save fails', async () => {
    updateCycleSettings.mockRejectedValue(new Error('Team admins only.'));
    renderSection();

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Enable cycles' })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(currentToasts()).toEqual([]);
  });

  it('shows a reader the schedule without letting them change it', async () => {
    getCycleSettings.mockResolvedValue(
      settings({ enabled: true, duration_weeks: 4, cooldown_weeks: 1 })
    );
    renderSection(false);

    expect(await screen.findByLabelText('Cycle length')).toHaveValue('4');
    expect(screen.getByLabelText('Cycle length')).toBeDisabled();
    expect(screen.getByLabelText('Cooldown')).toBeDisabled();
    expect(screen.getByLabelText('Cycle start day')).toBeDisabled();
    expect(screen.getByLabelText('Upcoming cycles')).toBeDisabled();
    expect(
      screen.getByRole('switch', { name: 'Enable cycles' })
    ).toBeDisabled();
    expect(
      screen.getByRole('switch', { name: 'Auto-add started issues' })
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Save' })
    ).not.toBeInTheDocument();
  });
});
