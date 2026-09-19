/**
 * The board. Covers that the read is bounded by a column cap rather than the
 * backlog, that a deep column pages on its own route, and above all that moving
 * a card writes the issue's status through the M2 issue route rather than any
 * board route, which is what keeps one write path onto an issue.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BoardRead,
  IssueListRead,
  IssueRead,
  ProjectMemberRead,
} from '../../types/Api';
import BoardView from './BoardView';

const getBoard = vi.fn<(query: unknown) => Promise<BoardRead>>();
const listBoardColumn =
  vi.fn<(statusId: string, query: unknown) => Promise<IssueListRead>>();
const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    getBoard: (_w: string, _p: string, query: unknown) => getBoard(query),
    listBoardColumn: (
      _w: string,
      statusId: string,
      _p: string,
      query: unknown
    ) => listBoardColumn(statusId, query),
  };
});

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    updateIssue: (_w: string, id: string, body: unknown) =>
      updateIssue(id, body),
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

/** One issue on a board card. */
const issue = (over: Partial<IssueRead> = {}): IssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  project_id: 'proj-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'st-todo',
  priority: 'high',
  assignee_id: 'user-1',
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  milestone_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  ...over,
});

const people: ProjectMemberRead[] = [
  {
    user_id: 'user-1',
    email: 'ada@example.com',
    display_name: 'Ada',
    role: 'member',
    added_at: '2026-09-17T00:00:00Z',
  },
];

/** A board with a full To do column and an empty Done one. */
const board = (over: Partial<BoardRead> = {}): BoardRead => ({
  project_id: 'proj-1',
  columns: [
    {
      status_id: 'st-todo',
      name: 'To do',
      category: 'unstarted',
      position: 0,
      issues: [issue()],
      total: 30,
      next_cursor: 'cur-1',
    },
    {
      status_id: 'st-done',
      name: 'Done',
      category: 'completed',
      position: 1,
      issues: [],
      total: 0,
      next_cursor: null,
    },
  ],
  ...over,
});

const renderBoard = (over: Partial<React.ComponentProps<typeof BoardView>> = {}) =>
  render(
    <MemoryRouter>
      <BoardView
        workspaceId="ws-1"
        projectId="proj-1"
        slug="mine"
        filters={{ assigneeId: '', labelId: '', priority: '' }}
        people={people}
        canEdit
        {...over}
      />
    </MemoryRouter>
  );

beforeEach(() => {
  getBoard.mockReset();
  listBoardColumn.mockReset();
  updateIssue.mockReset();
  getBoard.mockResolvedValue(board());
  listBoardColumn.mockResolvedValue({
    issues: [issue({ id: 'iss-2', key: 'ENG-2', title: 'Warm it up' })],
    next_cursor: null,
  });
  updateIssue.mockResolvedValue(issue({ status_id: 'st-done' }));
});

describe('board view', () => {
  it('renders a column per status', async () => {
    renderBoard();

    expect(await screen.findByLabelText('To do')).toBeInTheDocument();
    expect(screen.getByLabelText('Done')).toBeInTheDocument();
  });

  it('caps each column rather than asking for the whole backlog', async () => {
    renderBoard();

    await waitFor(() => {
      expect(getBoard).toHaveBeenCalledWith(
        expect.objectContaining({ column_limit: 25 })
      );
    });
  });

  it('passes the filters it reads under', async () => {
    renderBoard({
      filters: { assigneeId: 'user-1', labelId: 'lab-1', priority: 'high' },
    });

    await waitFor(() => {
      expect(getBoard).toHaveBeenCalledWith(
        expect.objectContaining({
          assignee_id: 'user-1',
          label_id: 'lab-1',
          priority: 'high',
        })
      );
    });
  });

  it('leaves an unset filter out of the query entirely', async () => {
    renderBoard();

    await waitFor(() => {
      expect(getBoard).toHaveBeenCalled();
    });
    const [query] = getBoard.mock.calls[0] ?? [];
    expect(query).not.toHaveProperty('assignee_id');
    expect(query).not.toHaveProperty('label_id');
    expect(query).not.toHaveProperty('priority');
  });

  it('moves a card through the issue route, never a board route', async () => {
    const user = userEvent.setup();
    renderBoard();

    await screen.findByLabelText('To do');
    await user.selectOptions(screen.getByLabelText('Move to'), 'st-done');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        status_id: 'st-done',
      });
    });
  });

  it('pages a deep column on its own route', async () => {
    const user = userEvent.setup();
    renderBoard();

    const column = await screen.findByLabelText('To do');
    await user.click(within(column).getByRole('button', { name: 'Load more' }));

    await waitFor(() => {
      expect(listBoardColumn).toHaveBeenCalledWith(
        'st-todo',
        expect.objectContaining({ cursor: 'cur-1' })
      );
    });
    expect(await screen.findByText('Warm it up')).toBeInTheDocument();
  });

  it('offers no load more on a column that has no cursor', async () => {
    renderBoard();

    const column = await screen.findByLabelText('Done');
    expect(
      within(column).queryByRole('button', { name: 'Load more' })
    ).not.toBeInTheDocument();
  });

  it('links a card at the workspace key route', async () => {
    renderBoard();

    const link = await screen.findByRole('link', { name: /ENG-1/ });
    expect(link).toHaveAttribute('href', '/w/mine/issues/ENG-1');
  });

  it('hides the move control from someone who may only read', async () => {
    renderBoard({ canEdit: false });

    await screen.findByLabelText('To do');
    expect(screen.queryByLabelText('Move to')).not.toBeInTheDocument();
  });

  it('says so when the project has no statuses', async () => {
    getBoard.mockResolvedValue({ project_id: 'proj-1', columns: [] });
    renderBoard();

    expect(
      await screen.findByText('This project has no statuses yet.')
    ).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    getBoard.mockRejectedValue(new Error('boom'));
    renderBoard();

    expect(
      await screen.findByText('Could not load the board.')
    ).toBeInTheDocument();
  });
});
