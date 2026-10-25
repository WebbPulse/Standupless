/**
 * Touch gestures on list rows: a swipe right opens the status picker for that
 * one issue, a swipe left opens the quick menu whose Assign to me takes the
 * issue, a long press opens the row menu, and a row does not start an HTML
 * drag under a finger, where the long press needs the press.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import { LONG_PRESS_MS } from '../../../hooks/useSwipeActions';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../../hooks/useShortcuts';
import {
  defaultViewState,
  type IssueContext,
  type ViewState,
} from '../../../lib/issueView';
import { START, swipe, touchPointer } from '../../../test/touch';
import IssueListView from './IssueListView';

vi.mock(
  '../../../hooks/useProjectStatuses',
  () => import('../../../test/projectStatuses')
);

vi.mock('../../../hooks/useCoarsePointer', () => ({
  useCoarsePointer: () => true,
}));

vi.mock('../../../lib/haptics', () => ({ buzz: vi.fn() }));

/** One issue in a status at a priority. */
const make = (
  id: string,
  statusId: string,
  priority: OrderedIssueRead['priority']
): OrderedIssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: `Issue ${id}`,
  body: null,
  status_id: statusId,
  priority,
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
});

const issues = [
  make('a1', 'st-a', 'urgent'),
  make('a2', 'st-a', 'high'),
  make('c1', 'st-c', 'high'),
];

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

let update: ReturnType<typeof vi.fn<IssueCollection['update']>>;
let onStateChange: ReturnType<typeof vi.fn<(state: ViewState) => void>>;

/** The list grouped by status. */
const listState = (overrides: Partial<ViewState> = {}): ViewState => ({
  ...defaultViewState('list'),
  groupBy: 'status',
  subGroupBy: 'none',
  showEmpty: false,
  ...overrides,
});

/** Mounts the list view with a mocked write path. */
const renderView = (state: ViewState = listState()) => {
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={createShortcutRegistry()}>
        <IssueListView
          slug="mine"
          state={state}
          onStateChange={onStateChange}
          collection={{
            issues,
            isLoading: false,
            error: null,
            truncated: false,
            queryKey: ['issues'],
            update,
          }}
          lists={lists}
          scaleFor={() => 'off'}
          canEdit
        />
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** The row of an issue. */
const row = (id: string): HTMLElement => {
  const found = screen.getByText(`Issue ${id}`).closest('li');
  if (found === null) throw new Error(`no row for ${id}`);
  return found;
};

beforeEach(() => {
  update = vi.fn<IssueCollection['update']>();
  onStateChange = vi.fn<(state: ViewState) => void>();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('touch gestures on list rows', () => {
  it('opens the status picker for the row on a swipe right', () => {
    renderView();

    swipe(row('a2'), 120);

    expect(
      screen.getByRole('dialog', { name: 'Change status, ENG-a2' })
    ).toBeInTheDocument();
  });

  it('opens the quick menu on a swipe left and assigns the issue to me', () => {
    renderView();

    swipe(row('a1'), -120);
    const menu = screen.getByRole('menu', { name: 'ENG-a1 quick actions' });
    expect(
      within(menu).getByRole('menuitem', { name: /Priority/ })
    ).toBeInTheDocument();
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Assign to me' })
    );

    expect(update).toHaveBeenCalledWith(['a1'], { assignee_id: 'user-1' });
  });

  it('opens the row menu on a long press', () => {
    vi.useFakeTimers();
    renderView();

    touchPointer(row('c1'), 'pointerdown', START.x, START.y);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    touchPointer(row('c1'), 'pointerup', START.x, START.y);

    expect(
      screen.getByRole('menu', { name: 'ENG-c1 actions' })
    ).toBeInTheDocument();
  });

  it('does not start an HTML drag under a finger', () => {
    renderView();

    expect(row('a1')).not.toHaveAttribute('draggable', 'true');
  });
});
