/**
 * The empty list: with filters or a search term that match nothing it reads
 * "No results" and offers Clear filters, which drops the filters and the
 * search but keeps the grouping and ordering. With none it offers Create
 * issue with its C shortcut to a viewer who may create, and the message
 * alone to one who may not. When completed issues hidden by the display
 * options would show, it says how many and offers to show them.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
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

vi.mock(
  '../../../hooks/useProjectStatuses',
  () => import('../../../test/projectStatuses')
);

/** One issue in a status. */
const make = (id: string, statusId: string): OrderedIssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: `Issue ${id}`,
  body: null,
  status_id: statusId,
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
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  completed_at: '2026-01-01T00:00:00Z',
});

const context: IssueContext = {
  statuses: [
    {
      id: 'st-done',
      name: 'Done',
      category: 'completed',
      position: 0,
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
let change: ReturnType<typeof vi.fn<(state: ViewState) => void>>;

/** Mounts the list over the given issues, state and create rights. */
const renderList = ({
  state = defaultViewState('list'),
  issues = [],
  canCreate = true,
  canEdit = true,
  emptyMessage,
}: {
  state?: ViewState;
  issues?: OrderedIssueRead[];
  canCreate?: boolean;
  canEdit?: boolean;
  emptyMessage?: string;
} = {}) => {
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
            onStateChange={change}
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
            canEdit={canEdit}
            {...(emptyMessage === undefined ? {} : { emptyMessage })}
          />
        </CreateIssueContext.Provider>
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** The empty state around the message given. */
const emptyAround = (message: string | RegExp): HTMLElement => {
  const node = screen.getByText(message).closest('div');
  if (node === null) throw new Error('no empty state');
  return node;
};

beforeEach(() => {
  open = vi.fn<CreateIssueState['open']>();
  change = vi.fn<(state: ViewState) => void>();
});

describe('IssueListView empty states', () => {
  it('offers clearing the filters and search but keeps the arrangement', () => {
    const state: ViewState = {
      ...defaultViewState('list'),
      filters: [{ field: 'priority', op: 'is', values: ['urgent'] }],
      q: 'cache',
      groupBy: 'priority',
      ordering: 'created_desc',
    };
    renderList({ state });

    const empty = emptyAround('No results');
    expect(
      within(empty).queryByRole('button', { name: 'Create issue' })
    ).toBeNull();
    fireEvent.click(
      within(empty).getByRole('button', { name: 'Clear filters' })
    );

    expect(change).toHaveBeenCalledWith({
      ...state,
      filters: [],
      match: 'all',
      groups: [],
      q: '',
    });
  });

  it('offers clearing a search term on its own', () => {
    renderList({ state: { ...defaultViewState('list'), q: 'nothing' } });

    expect(
      within(emptyAround('No results')).getByRole('button', {
        name: 'Clear filters',
      })
    ).toBeInTheDocument();
  });

  it('offers clearing filters to a viewer who cannot create', () => {
    renderList({
      state: {
        ...defaultViewState('list'),
        filters: [{ field: 'priority', op: 'is', values: ['urgent'] }],
      },
      canCreate: false,
      canEdit: false,
    });

    expect(
      screen.getByRole('button', { name: 'Clear filters' })
    ).toBeInTheDocument();
  });

  it('offers the first issue with its shortcut when nothing is filtered', () => {
    renderList();

    const empty = emptyAround(
      'No issues in this team yet. Create the first one to get started.'
    );
    expect(within(empty).getByText('C')).toBeInTheDocument();
    fireEvent.click(
      within(empty).getByRole('button', { name: 'Create issue' })
    );

    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ teamId: 'team-1' });
  });

  it('shows a viewer who cannot create the message alone', () => {
    renderList({ canCreate: false, emptyMessage: 'Nothing here.' });

    expect(
      within(emptyAround('Nothing here.')).queryByRole('button')
    ).toBeNull();
  });

  it('shows a guest without write rights the message alone', () => {
    renderList({ canEdit: false, emptyMessage: 'Nothing here.' });

    expect(
      within(emptyAround('Nothing here.')).queryByRole('button')
    ).toBeNull();
  });

  it('offers to show completed issues the display options hide', () => {
    const state: ViewState = { ...defaultViewState('list'), completed: 'none' };
    renderList({
      state,
      issues: [make('d1', 'st-done'), make('d2', 'st-done')],
      emptyMessage: 'Nothing here.',
    });

    expect(
      screen.getByText('2 completed issues are hidden by the display options.')
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'No issues in this team yet. Create the first one to get started.'
      )
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show completed issues' })
    );

    expect(change).toHaveBeenCalledWith({ ...state, completed: 'all' });
  });

  it('pairs the completed hint with Clear filters when filtered', () => {
    renderList({
      state: { ...defaultViewState('list'), completed: 'none', q: 'done' },
      issues: [make('d1', 'st-done')],
    });

    expect(
      screen.getByText('1 completed issue is hidden by the display options.')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Clear filters' })
    ).toBeInTheDocument();
  });
});
