/**
 * The cycle switcher. Covers that the arrows step through the team's cycles
 * in date order, skipping cancelled ones, and stand disabled at either end,
 * that the dropdown lists the cycles current first and filters by typing,
 * and that the palette carries the previous, next and current cycle steps.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ShortcutRegistryContext,
  createShortcutRegistry,
  type ShortcutRegistry,
} from '../../hooks/useShortcuts';
import type { CycleListRead, CycleRead } from '../../types/Api';
import CycleSwitcher, {
  neighbourCycles,
  steppingOrder,
  switcherCycles,
} from './CycleSwitcher';

const listCycles = vi.fn<(query: unknown) => Promise<CycleListRead>>();

vi.mock('../../api/planning', () => ({
  listCycles: (_w: string, query: unknown) => listCycles(query),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** A cycle of team `proj-1` starting on `start`, in the given state. */
const make = (
  id: string,
  start: string,
  status: CycleRead['status'],
  number: number
): CycleRead => ({
  cycle_id: id,
  workspace_id: 'ws-1',
  team_id: 'proj-1',
  name: '',
  number,
  start_date: start,
  end_date: start,
  goal: null,
  cancelled: status === 'cancelled',
  status,
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'user-1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
});

const first = make('cyc-1', '2026-09-01', 'completed', 1);
const dropped = make('cyc-x', '2026-09-08', 'cancelled', 9);
const second = make('cyc-2', '2026-09-15', 'active', 2);
const third = make('cyc-3', '2026-09-29', 'upcoming', 3);
const fourth = make('cyc-4', '2026-10-13', 'upcoming', 4);
const other = { ...make('cyc-o', '2026-09-20', 'upcoming', 7), team_id: 'p2' };

const all = [fourth, second, other, dropped, first, third];

/** Shows the route the switcher navigated to. */
const Where = () => {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
};

const renderSwitcher = (cycle: CycleRead, registry?: ShortcutRegistry) =>
  render(
    <ShortcutRegistryContext.Provider value={registry ?? null}>
      <MemoryRouter initialEntries={['/w/mine/team/ENG/cycles/here']}>
        <CycleSwitcher
          workspaceId="ws-1"
          slug="mine"
          teamId="proj-1"
          keyPrefix="ENG"
          cycle={cycle}
        />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ShortcutRegistryContext.Provider>
  );

describe('cycle ordering', () => {
  it('steps through the team cycles by start date, skipping cancelled ones', () => {
    expect(
      steppingOrder(all, 'proj-1', 'cyc-2').map((row) => row.cycle_id)
    ).toEqual(['cyc-1', 'cyc-2', 'cyc-3', 'cyc-4']);
  });

  it('keeps a cancelled cycle in the order while it is in view', () => {
    expect(
      steppingOrder(all, 'proj-1', 'cyc-x').map((row) => row.cycle_id)
    ).toEqual(['cyc-1', 'cyc-x', 'cyc-2', 'cyc-3', 'cyc-4']);
  });

  it('has no neighbour past either end', () => {
    const order = steppingOrder(all, 'proj-1', 'cyc-1');
    expect(neighbourCycles(order, 'cyc-1')).toEqual({
      previous: null,
      next: second,
    });
    expect(neighbourCycles(order, 'cyc-4')).toEqual({
      previous: third,
      next: null,
    });
  });

  it('lists current, then upcoming soonest first, then the past', () => {
    expect(switcherCycles(all, 'proj-1').map((row) => row.cycle_id)).toEqual([
      'cyc-2',
      'cyc-3',
      'cyc-4',
      'cyc-1',
      'cyc-x',
    ]);
  });
});

describe('CycleSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCycles.mockResolvedValue({ cycles: all, next_cursor: null });
  });

  it('steps to the previous and next cycle from the arrows', async () => {
    const user = userEvent.setup();
    renderSwitcher(second);

    const previous = screen.getByRole('button', { name: 'Previous cycle' });
    await waitFor(() => {
      expect(previous).toBeEnabled();
    });
    await user.click(previous);
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/w/mine/team/ENG/cycles/cyc-1'
    );
    await user.click(screen.getByRole('button', { name: 'Next cycle' }));
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/w/mine/team/ENG/cycles/cyc-3'
    );
  });

  it('disables the arrow at each end of the range', async () => {
    const { unmount } = renderSwitcher(first);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next cycle' })).toBeEnabled();
    });
    expect(
      screen.getByRole('button', { name: 'Previous cycle' })
    ).toBeDisabled();
    unmount();

    renderSwitcher(fourth);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Previous cycle' })
      ).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: 'Next cycle' })).toBeDisabled();
  });

  it('opens a cycle picked from the filtered dropdown', async () => {
    const user = userEvent.setup();
    renderSwitcher(second);
    await waitFor(() => {
      expect(listCycles).toHaveBeenCalled();
    });

    await user.click(
      screen.getByRole('button', { name: 'Cycle 2, switch cycle' })
    );
    expect(await screen.findByText('Current')).toBeInTheDocument();
    expect(screen.getAllByText('Upcoming').length).toBeGreaterThan(0);
    expect(screen.getByText('Previous')).toBeInTheDocument();
    expect(screen.queryByText('Cycle 7')).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Switch to cycle'), 'Cycle 4');
    expect(screen.queryByText('Cycle 3')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('where')).toHaveTextContent(
      '/w/mine/team/ENG/cycles/cyc-4'
    );
  });

  it('offers the previous, next and current cycle in the palette', async () => {
    const registry = createShortcutRegistry();
    renderSwitcher(third, registry);
    await waitFor(() => {
      expect(registry.list().map((shortcut) => shortcut.label)).toEqual(
        expect.arrayContaining([
          'Go to previous cycle',
          'Go to next cycle',
          'Go to current cycle',
        ])
      );
    });
    const run = (label: string): void => {
      const found = registry.list().find((row) => row.label === label);
      act(() => {
        found?.run();
      });
    };
    expect(
      registry.list().find((row) => row.label === 'Go to current cycle')?.keys
    ).toBe('g v');

    run('Go to current cycle');
    expect(screen.getByTestId('where')).toHaveTextContent(
      '/w/mine/team/ENG/cycles/cyc-2'
    );
  });

  it('drops the palette step past the last cycle', async () => {
    const registry = createShortcutRegistry();
    renderSwitcher(fourth, registry);
    await waitFor(() => {
      expect(
        registry.list().some((row) => row.label === 'Go to previous cycle')
      ).toBe(true);
    });
    expect(
      registry.list().some((row) => row.label === 'Go to next cycle')
    ).toBe(false);
  });
});
