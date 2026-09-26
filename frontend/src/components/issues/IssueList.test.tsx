/**
 * The issue list. Covers that a first read shows placeholder rows rather than
 * a spinner, that the empty state and the error still read as before, and that
 * the keyboard moves a highlight and opens the highlighted issue.
 */

import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueListRead, IssueRead, StatusRead } from '../../types/Api';
import IssueList from './IssueList';

const listIssues = vi.fn<() => Promise<IssueListRead>>();
const navigate = vi.fn<(to: string) => void>();

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    listIssues: () => listIssues(),
  };
});

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => navigate };
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

const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Todo', category: 'unstarted', position: 1 },
];

const issue = (number: number): IssueRead => ({
  id: `iss-${number}`,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${number}`,
  number,
  title: `Issue ${number}`,
  body: null,
  status_id: 'st-1',
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
});

const renderList = () =>
  render(
    <MemoryRouter>
      <IssueList
        workspaceId="ws-1"
        slug="acme"
        query={{}}
        queryKey={['issues', 'ws-1']}
        statuses={statuses}
        labels={[]}
        people={[]}
      />
    </MemoryRouter>
  );

beforeEach(() => {
  listIssues.mockReset();
  navigate.mockReset();
  listIssues.mockResolvedValue({
    issues: [issue(1), issue(2), issue(3)],
    next_cursor: null,
  });
});

describe('while the first page is in flight', () => {
  it('holds the list height with placeholder rows', () => {
    listIssues.mockReturnValue(new Promise(() => undefined));

    renderList();

    expect(
      screen.getByRole('status', { name: 'Loading issues' })
    ).toBeInTheDocument();
  });
});

describe('once the rows land', () => {
  it('draws one row per issue', async () => {
    renderList();

    expect(await screen.findByText('Issue 1')).toBeInTheDocument();
    expect(screen.getByText('Issue 3')).toBeInTheDocument();
  });

  it('shows the empty sentence when nothing matches', async () => {
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });

    renderList();

    expect(
      await screen.findByText('No issues match these filters.')
    ).toBeInTheDocument();
  });

  it('shows the refusal when the read fails', async () => {
    listIssues.mockRejectedValue(new Error('nope'));

    renderList();

    expect(
      await screen.findByText('Could not load these issues.')
    ).toBeInTheDocument();
  });
});

describe('the keyboard', () => {
  /**
   * Waits for the rows and then for the effect that attaches the key listener,
   * because a key dispatched between the two is lost and the test would race.
   */
  const renderReady = async () => {
    renderList();
    await screen.findByText('Issue 1');
    await act(async () => {
      await Promise.resolve();
    });
  };

  const press = (key: string) => {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true })
      );
    });
  };

  it('moves a highlight down the rows', async () => {
    await renderReady();

    press('j');

    expect(screen.getByText('Issue 1').closest('li')).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('opens the highlighted issue on Enter', async () => {
    await renderReady();

    press('j');
    press('j');
    expect(screen.getByText('Issue 2').closest('li')).toHaveAttribute(
      'aria-current',
      'true'
    );

    press('Enter');

    expect(navigate).toHaveBeenCalledWith('/w/acme/issues/ENG-2');
  });

  it('clears the highlight on Escape', async () => {
    await renderReady();

    press('j');
    expect(screen.getByText('Issue 1').closest('li')).toHaveAttribute(
      'aria-current',
      'true'
    );

    press('Escape');

    expect(screen.getByText('Issue 1').closest('li')).not.toHaveAttribute(
      'aria-current'
    );
  });
});
