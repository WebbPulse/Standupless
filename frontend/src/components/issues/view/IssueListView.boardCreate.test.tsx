/**
 * The New issue row at the foot of each board cell: it opens the create dialog
 * with the column's status, and the lane's value in swimlanes, already set, it
 * stays visible in an empty cell, and it is left out for viewers who cannot
 * create.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../../hooks/useCreateIssue';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../../hooks/useShortcuts';
import {
  defaultViewState,
  type IssueContext,
  type ViewState,
} from '../../../lib/issueView';
import IssueListView from './IssueListView';

/** One issue in a status, optionally assigned. */
const make = (
  id: string,
  statusId: string,
  assigneeId: string | null = null
): OrderedIssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: `Issue ${id}`,
  body: null,
  status_id: statusId,
  priority: 'none',
  assignee_id: assigneeId,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
});

const issues = [make('a1', 'st-a', 'user-1'), make('c1', 'st-c', 'user-1')];

const context: IssueContext = {
  statuses: [
    {
      id: 'st-a',
      name: 'Backlog',
      category: 'backlog',
      position: 0,
      team_id: 'team-1',
    },
    {
      id: 'st-b',
      name: 'Todo',
      category: 'unstarted',
      position: 1,
      team_id: 'team-1',
    },
    {
      id: 'st-c',
      name: 'Doing',
      category: 'started',
      position: 2,
      team_id: 'team-1',
    },
  ],
  labels: [],
  people: [{ user_id: 'user-1', email: 'me@example.com', display_name: 'Me' }],
  projects: [],
  cycles: [],
  currentUserId: 'user-1',
};

const lists: IssueContextState = {
  context,
  forTeam: () => context,
  isLoading: false,
  createLabel: () => Promise.resolve(null),
};

let open: ReturnType<typeof vi.fn<CreateIssueState['open']>>;

/** Mounts the board inside a create dialog provider. */
const renderBoard = (
  state: ViewState = defaultViewState('board'),
  canCreate = true
) => {
  const creator: CreateIssueState = {
    open,
    close: vi.fn(),
    isOpen: false,
    canCreate,
    request: null,
  };
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={createShortcutRegistry()}>
        <CreateIssueContext.Provider value={creator}>
          <IssueListView
            slug="mine"
            state={state}
            onStateChange={vi.fn()}
            collection={{
              issues,
              isLoading: false,
              error: null,
              truncated: false,
              queryKey: ['issues'],
              update: vi.fn<IssueCollection['update']>(),
            }}
            lists={lists}
            scaleFor={() => 'off'}
            createTeamId="team-1"
            canEdit
          />
        </CreateIssueContext.Provider>
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

beforeEach(() => {
  open = vi.fn<CreateIssueState['open']>();
});

describe('board column New issue row', () => {
  it('opens the create dialog with the column status set', () => {
    renderBoard();

    fireEvent.click(
      screen.getByRole('button', { name: 'New issue at the end of Doing' })
    );

    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      teamId: 'team-1',
      statusId: 'st-c',
    });
  });

  it('stays visible in an empty column and quiet in a filled one', () => {
    renderBoard();

    expect(
      screen.getByRole('button', { name: 'New issue at the end of Todo' })
    ).toHaveClass('opacity-100');
    expect(
      screen.getByRole('button', { name: 'New issue at the end of Backlog' })
    ).toHaveClass('opacity-0');
  });

  it('sets the lane value too in swimlanes', () => {
    renderBoard({ ...defaultViewState('board'), subGroupBy: 'assignee' });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'New issue at the end of Backlog, Me',
      })
    );

    expect(open.mock.calls[0]?.[0]).toMatchObject({
      teamId: 'team-1',
      statusId: 'st-a',
      assigneeId: 'user-1',
    });
  });

  it('is left out for viewers who cannot create', () => {
    renderBoard(defaultViewState('board'), false);

    expect(
      screen.queryByRole('button', { name: /^New issue at the end of/ })
    ).toBeNull();
  });
});
