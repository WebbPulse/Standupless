/**
 * The cycle card a hover opens: a skeleton while the first read is in flight,
 * the cycle's title, number, state, dates, goal and progress once it lands,
 * and a no access note when the reader cannot see it. An active cycle reads
 * its days left, an upcoming one the days until it starts, and a completed
 * one says so. Progress reads in points when the team estimates. Keyboard
 * focus on the trigger opens it.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../contexts/WorkspaceContextDefinition';
import type { WorkspaceRead } from '../../types/Api';
import { HOVER_CARD_OPEN_DELAY_MS } from './hover-card';
import {
  CycleCard,
  CycleCardBody,
  CycleHoverTrigger,
  type CycleCardCycle,
} from './CycleHoverCard';

const polled = vi.fn<() => { data: unknown; isLoading: boolean }>();

const teams = vi.fn(() => [
  {
    id: 'team-1',
    name: 'Engineering',
    key_prefix: 'ENG',
    estimate_scale: 'off',
  },
]);

vi.mock('@webbpulse/api-client/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePolledQuery: () => ({ error: null, ...polled() }),
}));

vi.mock('@webbpulse/auth/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
}));

vi.mock('../../hooks/useTeams', () => ({
  useTeamsFor: () => ({ data: teams() }),
}));

const workspaceValue: WorkspaceContextType = {
  workspace: { id: 'ws-1', slug: 'acme' } as WorkspaceRead,
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
};

const today = new Date(2026, 9, 20);

const cycle: CycleCardCycle & { team_id: string } = {
  cycle_id: 'cyc-1',
  team_id: 'team-1',
  name: 'Polish sprint',
  number: 7,
  start_date: '2026-10-12',
  end_date: '2026-10-25',
  goal: 'Ship the hover cards',
  status: 'active',
  counts: { todo: 2, in_progress: 1, done: 3, cancelled: 2, total: 8 },
  points: { todo: 4, in_progress: 2, done: 6, cancelled: 0, total: 12 },
};

/** Draws `children` inside the acme workspace. */
const inWorkspace = (children: ReactNode) => (
  <MemoryRouter>
    <WorkspaceContext.Provider value={workspaceValue}>
      {children}
    </WorkspaceContext.Provider>
  </MemoryRouter>
);

beforeEach(() => {
  polled.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CycleCard', () => {
  it('shows an active cycle with its days left, dates, goal and number', () => {
    render(
      inWorkspace(
        <CycleCard
          cycle={{ ...cycle, points: undefined }}
          href="/w/acme/team/ENG/cycles/cyc-1"
          today={today}
        />
      )
    );

    expect(screen.getByRole('link', { name: 'Polish sprint' })).toHaveAttribute(
      'href',
      '/w/acme/team/ENG/cycles/cyc-1'
    );
    expect(screen.getByText('Cycle 7')).toBeInTheDocument();
    expect(screen.getByTestId('cycle-card-state')).toHaveTextContent(
      'Active · 5 days left'
    );
    expect(screen.getByText(/Oct 12/)).toBeInTheDocument();
    expect(screen.getByText('Ship the hover cards')).toBeInTheDocument();
    expect(screen.getByTestId('cycle-card-progress')).toHaveTextContent('50%');
    expect(screen.getByText(/3 of 6 issues/)).toBeInTheDocument();
  });

  it('shows an upcoming cycle with the days until it starts', () => {
    render(
      inWorkspace(
        <CycleCard
          cycle={{
            ...cycle,
            status: 'upcoming',
            start_date: '2026-10-23',
            end_date: '2026-11-05',
            goal: null,
            points: undefined,
          }}
          today={today}
        />
      )
    );

    expect(screen.getByTestId('cycle-card-state')).toHaveTextContent(
      'Upcoming · Starts in 3 days'
    );
    expect(screen.queryByText('Ship the hover cards')).not.toBeInTheDocument();
  });

  it('shows a completed cycle with its progress in points', () => {
    render(
      inWorkspace(
        <CycleCard
          cycle={{ ...cycle, status: 'completed' }}
          usesPoints
          today={today}
        />
      )
    );

    expect(screen.getByTestId('cycle-card-state')).toHaveTextContent(
      'Completed'
    );
    expect(screen.getByTestId('cycle-card-progress')).toHaveTextContent('50%');
    expect(screen.getByText(/6 of 12 points/)).toBeInTheDocument();
  });
});

describe('CycleCardBody', () => {
  it('shows a skeleton while the first read is in flight', () => {
    polled.mockReturnValue({ data: null, isLoading: true });
    const { container } = render(
      inWorkspace(<CycleCardBody cycleId="cyc-1" teamId="team-1" />)
    );

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('says so when the cycle is missing or hidden', () => {
    polled.mockReturnValue({ data: null, isLoading: false });
    render(inWorkspace(<CycleCardBody cycleId="cyc-1" teamId="team-1" />));

    expect(screen.getByText(/do not have access/)).toBeInTheDocument();
    expect(screen.queryByTestId('cycle-card')).not.toBeInTheDocument();
  });

  it('links the title to the cycle page of its team', () => {
    polled.mockReturnValue({ data: cycle, isLoading: false });
    render(inWorkspace(<CycleCardBody cycleId="cyc-1" teamId="team-1" />));

    expect(screen.getByRole('link', { name: 'Polish sprint' })).toHaveAttribute(
      'href',
      expect.stringContaining('/cycles/cyc-1')
    );
  });
});

describe('CycleHoverTrigger', () => {
  it('opens on keyboard focus', () => {
    vi.useFakeTimers();
    polled.mockReturnValue({ data: cycle, isLoading: false });
    render(
      inWorkspace(
        <CycleHoverTrigger cycleId="cyc-1" teamId="team-1">
          {(trigger) => (
            <button type="button" {...trigger}>
              Cycle chip
            </button>
          )}
        </CycleHoverTrigger>
      )
    );
    const button = screen.getByRole('button', { name: 'Cycle chip' });
    vi.spyOn(button, 'matches').mockReturnValue(true);

    fireEvent.focus(button);
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_OPEN_DELAY_MS);
    });
    expect(screen.getByTestId('cycle-card')).toBeInTheDocument();
  });

  it('draws the trigger plain with no team to read the cycle under', () => {
    vi.useFakeTimers();
    render(
      inWorkspace(
        <CycleHoverTrigger cycleId="cyc-1" teamId={null}>
          {(trigger) => (
            <button type="button" {...trigger}>
              Bare chip
            </button>
          )}
        </CycleHoverTrigger>
      )
    );
    const button = screen.getByRole('button', { name: 'Bare chip' });
    vi.spyOn(button, 'matches').mockReturnValue(true);

    fireEvent.focus(button);
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_OPEN_DELAY_MS);
    });
    expect(screen.queryByTestId('cycle-card')).not.toBeInTheDocument();
    expect(polled).not.toHaveBeenCalled();
  });
});
