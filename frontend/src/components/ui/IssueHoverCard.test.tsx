/**
 * The issue preview a hover card shows: a skeleton while the first read is in
 * flight, the issue's properties once it lands, and a not found state when the
 * reader cannot see it.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../contexts/WorkspaceContextDefinition';
import type { TeamOptions } from '../../hooks/useTeamOptions';
import type { IssueRead, WorkspaceRead } from '../../types/Api';
import { IssuePreview } from './IssueHoverCard';

const polled = vi.fn<() => { data: unknown; isLoading: boolean }>();

vi.mock('@webbpulse/api-client/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePolledQuery: () => ({ error: null, ...polled() }),
}));

vi.mock('@webbpulse/auth/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
}));

vi.mock('../../hooks/useTeamOptions', () => ({
  useTeamOptions: (): Partial<TeamOptions> => ({
    statuses: [
      {
        id: 'st-1',
        name: 'In Progress',
        category: 'started',
      } as TeamOptions['statuses'][number],
    ],
    labels: [{ id: 'lb-1', name: 'bug', color: '#f00' }],
    people: [
      {
        user_id: 'u-1',
        email: 'ada@example.com',
        display_name: 'ada',
        avatar_url: null,
        full_name: null,
      },
    ],
    projects: [
      {
        project_id: 'prj-1',
        name: 'Launch',
        icon: null,
        color: null,
      } as unknown as TeamOptions['projects'][number],
    ],
    cycles: [
      {
        cycle_id: 'cy-1',
        name: '',
        number: 7,
      } as unknown as TeamOptions['cycles'][number],
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

const renderPreview = () =>
  render(
    <MemoryRouter>
      <WorkspaceContext.Provider value={workspaceValue}>
        <IssuePreview issueKeyText="ENG-1" onOpen={vi.fn()} />
      </WorkspaceContext.Provider>
    </MemoryRouter>
  );

beforeEach(() => {
  polled.mockReset();
});

describe('IssuePreview', () => {
  it('shows a skeleton while the first read is in flight', () => {
    polled.mockReturnValue({ data: null, isLoading: true });
    const { container } = renderPreview();

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('says so when the issue is missing or hidden', () => {
    polled.mockReturnValue({ data: null, isLoading: false });
    renderPreview();

    expect(screen.getByText(/was not found/)).toBeInTheDocument();
  });

  it('shows the issue and its properties, linking to the issue', () => {
    polled.mockReturnValue({
      isLoading: false,
      data: {
        id: 'iss-1',
        key: 'ENG-1',
        title: 'Cache the token',
        team_id: 'team-1',
        status_id: 'st-1',
        priority: 'high',
        assignee_id: 'u-1',
        label_ids: ['lb-1'],
        project_id: 'prj-1',
        cycle_id: 'cy-1',
      } as IssueRead,
    });
    renderPreview();

    expect(
      screen.getByRole('link', { name: 'Open ENG-1 Cache the token' })
    ).toHaveAttribute('href', '/w/acme/issues/ENG-1');
    for (const text of [
      'Cache the token',
      'In Progress',
      'High',
      'ada',
      'bug',
      'Launch',
      'Cycle 7',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});
