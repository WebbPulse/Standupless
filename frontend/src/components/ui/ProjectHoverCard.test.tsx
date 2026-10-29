/**
 * The project card a hover opens: a skeleton while the first read is in
 * flight, the project's status, health, lead, target date, progress and teams
 * once it lands, and a no access note when the reader cannot see it. Keyboard
 * focus on the trigger opens it, and a trigger for a project the reader cannot
 * see draws plain with no card.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembersByIdContext } from '../../contexts/MentionMembersContextDefinition';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../contexts/WorkspaceContextDefinition';
import type { MemberRead, WorkspaceRead } from '../../types/Api';
import { HOVER_CARD_OPEN_DELAY_MS } from './hover-card';
import { ProjectCardBody, ProjectHoverTrigger } from './ProjectHoverCard';

const polled = vi.fn<() => { data: unknown; isLoading: boolean }>();

vi.mock('@webbpulse/api-client/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePolledQuery: () => ({ error: null, ...polled() }),
}));

vi.mock('@webbpulse/auth/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
}));

vi.mock('../../hooks/useProjectStatuses', () => ({
  useProjectStatuses: () => ({
    statusOf: () => ({
      id: 'in_progress',
      name: 'Building',
      category: 'in_progress',
      color: null,
    }),
  }),
}));

vi.mock('../../hooks/useTeams', () => ({
  useTeamsFor: () => ({
    data: [
      { id: 'team-1', name: 'Engineering' },
      { id: 'team-2', name: 'Design' },
    ],
  }),
}));

const workspaceValue: WorkspaceContextType = {
  workspace: { id: 'ws-1', slug: 'acme' } as WorkspaceRead,
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
};

const members = new Map<string, MemberRead>([
  [
    'u-1',
    {
      user_id: 'u-1',
      email: 'ada@example.com',
      display_name: 'ada',
    } as MemberRead,
  ],
]);

const project = {
  project_id: 'prj-1',
  name: 'Launch',
  icon: null,
  color: null,
  status: 'in_progress',
  status_id: 'in_progress',
  health: 'at_risk',
  lead_id: 'u-1',
  target_date: '2099-03-14',
  last_update_at: '2026-10-20T12:00:00Z',
  team_ids: ['team-1'],
  counts: { todo: 2, in_progress: 1, done: 3, cancelled: 2, total: 8 },
};

/** Draws `children` inside the acme workspace with its member list. */
const inWorkspace = (children: ReactNode) => (
  <MemoryRouter>
    <WorkspaceContext.Provider value={workspaceValue}>
      <MembersByIdContext.Provider value={members}>
        {children}
      </MembersByIdContext.Provider>
    </WorkspaceContext.Provider>
  </MemoryRouter>
);

beforeEach(() => {
  polled.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProjectCardBody', () => {
  it('shows a skeleton while the first read is in flight', () => {
    polled.mockReturnValue({ data: null, isLoading: true });
    const { container } = render(
      inWorkspace(<ProjectCardBody projectId="prj-1" />)
    );

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('says so when the project is missing or hidden', () => {
    polled.mockReturnValue({ data: null, isLoading: false });
    render(inWorkspace(<ProjectCardBody projectId="prj-1" />));

    expect(screen.getByText(/do not have access/)).toBeInTheDocument();
    expect(screen.queryByTestId('project-card')).not.toBeInTheDocument();
  });

  it('shows the status, health, lead, target, progress and teams', () => {
    polled.mockReturnValue({ data: project, isLoading: false });
    render(inWorkspace(<ProjectCardBody projectId="prj-1" />));

    expect(screen.getByRole('link', { name: 'Launch' })).toHaveAttribute(
      'href',
      expect.stringContaining('/w/acme/projects/')
    );
    for (const text of ['Building', 'At risk', 'ada', 'Engineering']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.queryByText('Design')).not.toBeInTheDocument();
    expect(screen.getByText(/Mar 14/)).toBeInTheDocument();
    expect(screen.getByTestId('project-card-progress')).toHaveTextContent(
      '50%'
    );
    expect(screen.getByText(/3 of 6 issues/)).toBeInTheDocument();
  });
});

describe('ProjectHoverTrigger', () => {
  it('opens on keyboard focus', () => {
    vi.useFakeTimers();
    polled.mockReturnValue({ data: project, isLoading: false });
    render(
      inWorkspace(
        <ProjectHoverTrigger projectId="prj-1">
          {(trigger) => (
            <button type="button" {...trigger}>
              Launch chip
            </button>
          )}
        </ProjectHoverTrigger>
      )
    );
    const button = screen.getByRole('button', { name: 'Launch chip' });
    vi.spyOn(button, 'matches').mockReturnValue(true);

    fireEvent.focus(button);
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_OPEN_DELAY_MS);
    });
    expect(screen.getByTestId('project-card')).toBeInTheDocument();
  });

  it('draws the trigger plain for a project the reader cannot see', () => {
    vi.useFakeTimers();
    render(
      inWorkspace(
        <ProjectHoverTrigger projectId="prj-1" disabled>
          {(trigger) => (
            <button type="button" {...trigger}>
              Hidden chip
            </button>
          )}
        </ProjectHoverTrigger>
      )
    );
    const button = screen.getByRole('button', { name: 'Hidden chip' });
    vi.spyOn(button, 'matches').mockReturnValue(true);

    fireEvent.focus(button);
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_OPEN_DELAY_MS);
    });
    expect(screen.queryByTestId('project-card')).not.toBeInTheDocument();
    expect(polled).not.toHaveBeenCalled();
  });
});
