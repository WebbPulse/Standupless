/**
 * That the list nests a sub-issue under its parent when sub-issues show,
 * folds it away from the parent's chevron, and that the side arrows fold,
 * unfold and step between a parent and its sub-issues while j and k walk the
 * rows in tree order.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  type ShortcutRegistry,
} from '../../../hooks/useShortcuts';
import {
  defaultViewState,
  type IssueContext,
  type ViewState,
} from '../../../lib/issueView';
import IssueListView from './IssueListView';

/** An open issue with the fields the test varies. */
const make = (
  id: string,
  number: number,
  title: string,
  priority: OrderedIssueRead['priority'],
  parent: string | null = null
): OrderedIssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${String(number)}`,
  number,
  title,
  body: null,
  status_id: 'st-1',
  priority,
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: parent,
  cycle_id: null,
  project_id: null,
  progress: { total: parent === null && id === 'iss-1' ? 1 : 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
});

const issues: OrderedIssueRead[] = [
  make('iss-1', 1, 'Parent work', 'low'),
  make('iss-2', 2, 'Child step', 'high', 'iss-1'),
  make('iss-3', 3, 'Other work', 'medium'),
];

const context: IssueContext = {
  statuses: [
    {
      id: 'st-1',
      name: 'Todo',
      category: 'unstarted',
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

let registry: ShortcutRegistry;
let update: ReturnType<typeof vi.fn<IssueCollection['update']>>;

/** Mounts the list over the three issues. */
const renderView = (state: Partial<ViewState> = {}) => {
  const collection: IssueCollection = {
    issues,
    isLoading: false,
    error: null,
    truncated: false,
    queryKey: ['issues'],
    update,
  };
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={registry}>
        <IssueListView
          slug="mine"
          state={{ ...defaultViewState('list'), ...state }}
          onStateChange={() => undefined}
          collection={collection}
          lists={lists}
          scaleFor={() => 'off'}
          canEdit
        />
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** Feeds one key press to the registry. */
const press = (key: string): void => {
  act(() => {
    registry.handleKey(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  });
};

/** The row ids in document order. */
const rowIds = (): (string | null)[] =>
  Array.from(document.querySelectorAll('[data-row-id]')).map((row) =>
    row.getAttribute('data-row-id')
  );

/** Assigns whatever has focus and reports which issue it was. */
const focusedIssue = (): string | undefined => {
  update.mockClear();
  press('i');
  return update.mock.calls[0]?.[0][0];
};

beforeEach(() => {
  registry = createShortcutRegistry();
  update = vi.fn<IssueCollection['update']>();
});

describe('IssueListView sub-issue tree', () => {
  it('draws a sub-issue indented beneath its parent', () => {
    renderView();

    expect(rowIds()).toEqual(['iss-3', 'iss-1', 'iss-2']);
    expect(
      document
        .querySelector('[data-row-id="iss-2"]')
        ?.getAttribute('aria-level')
    ).toBe('2');
  });

  it('keeps the flat order on a list that hides sub-issues', () => {
    renderView({ showSubIssues: false });

    expect(rowIds()).toEqual(['iss-3', 'iss-1']);
    expect(
      screen.queryByRole('button', { name: /sub-issues of/i })
    ).not.toBeInTheDocument();
  });

  it('folds the sub-issues away from the parent chevron', () => {
    renderView();

    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse sub-issues of ENG-1' })
    );
    expect(rowIds()).toEqual(['iss-3', 'iss-1']);

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand sub-issues of ENG-1' })
    );
    expect(rowIds()).toEqual(['iss-3', 'iss-1', 'iss-2']);
  });

  it('walks, folds and steps through the tree from the keyboard', () => {
    renderView();

    press('j');
    press('j');
    expect(focusedIssue()).toBe('iss-1');

    press('ArrowLeft');
    expect(rowIds()).toEqual(['iss-3', 'iss-1']);

    press('ArrowRight');
    expect(rowIds()).toEqual(['iss-3', 'iss-1', 'iss-2']);
    expect(focusedIssue()).toBe('iss-1');

    press('ArrowRight');
    expect(focusedIssue()).toBe('iss-2');

    press('ArrowLeft');
    expect(focusedIssue()).toBe('iss-1');

    press('j');
    expect(focusedIssue()).toBe('iss-2');
  });
});
