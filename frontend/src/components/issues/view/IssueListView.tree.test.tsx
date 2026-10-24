/**
 * That the list nests a sub-issue under its parent when sub-issues show,
 * folds it away from the parent's chevron, and that the side arrows fold,
 * unfold and step between a parent and its sub-issues while j and k walk the
 * rows in tree order. Also that a nested row draws its connector, a parent
 * carries its done/total chip, and a sub-issue shown apart from its parent
 * names that parent on its row and its board card.
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

/** Mounts the list over the given issues, the three above by default. */
const renderView = (
  state: Partial<ViewState> = {},
  shown: OrderedIssueRead[] = issues,
  layout: ViewState['layout'] = 'list'
) => {
  const collection: IssueCollection = {
    issues: shown,
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
          state={{ ...defaultViewState(layout), ...state }}
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

  it('draws an elbow into a nested row and none on a top-level one', () => {
    renderView();

    const child = document.querySelector('[data-row-id="iss-2"]');
    const parent = document.querySelector('[data-row-id="iss-1"]');
    expect(child?.querySelector('[data-guide="elbow"]')).not.toBeNull();
    expect(parent?.querySelector('[data-guide="elbow"]')).toBeNull();
    expect(parent?.querySelector('[data-guide="stub"]')).not.toBeNull();
  });

  it('shows a done over total chip on a parent row only', () => {
    renderView();

    const chips = document.querySelectorAll('[data-chip="sub-issues"]');
    expect(chips).toHaveLength(1);
    expect(
      chips[0]?.closest('[data-row-id]')?.getAttribute('data-row-id')
    ).toBe('iss-1');
    expect(chips[0]?.textContent).toContain('0/1');
  });

  it('names the parent of a sub-issue listed apart from it', () => {
    const apart = {
      ...make('iss-5', 5, 'Lone step', 'low', 'iss-9'),
      parent_key: 'ENG-9',
      parent_title: 'Faraway parent',
    };
    renderView({}, [apart]);

    const link = screen.getByRole('link', {
      name: 'Parent issue ENG-9 Faraway parent',
    });
    expect(link.getAttribute('href')).toBe('/w/mine/issues/ENG-9');
  });

  it('names a loaded parent and its progress on a board card', () => {
    renderView({}, issues, 'board');

    const link = screen.getByRole('link', {
      name: /^Parent issue ENG-1 Parent work/,
    });
    expect(link.textContent).toContain('0/1');
  });
});
