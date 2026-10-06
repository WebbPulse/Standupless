/**
 * The board's keys: h and l and the side arrows cross columns, skipping empty
 * ones, j and k stay in the focused column, labels move to Shift+L, and the
 * column keys are listed for the help overlay and the palette only on a board.
 */

import { act, render, screen } from '@testing-library/react';
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
import type { ViewLayout } from '../../../api/views';
import { defaultViewState, type IssueContext } from '../../../lib/issueView';
import IssueListView from './IssueListView';

/** One issue in a status, ranked by its priority inside the column. */
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

let registry: ShortcutRegistry;
let update: ReturnType<typeof vi.fn<IssueCollection['update']>>;

/** Mounts the view in a layout, inside a shortcut registry. */
const renderView = (layout: ViewLayout = 'board') => {
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={registry}>
        <IssueListView
          slug="mine"
          state={defaultViewState(layout)}
          onStateChange={vi.fn()}
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

/** Feeds one key press to the registry, as the provider's listener would. */
const press = (key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    registry.handleKey(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
};

/** The issue in focus, read back by assigning it to the viewer with I. */
const focusedId = (): string | undefined => {
  update.mockClear();
  press('i');
  const ids: readonly string[] | undefined = update.mock.calls[0]?.[0];
  return ids?.[0];
};

beforeEach(() => {
  registry = createShortcutRegistry();
  update = vi.fn<IssueCollection['update']>();
});

describe('IssueListView board keys', () => {
  it('crosses to the next filled column on L and back on H', () => {
    renderView();
    expect(screen.getByText('Issue a1')).toBeInTheDocument();

    press('j');
    press('j');
    press('l');
    expect(focusedId()).toBe('c1');

    press('h');
    expect(focusedId()).toBe('a1');
  });

  it('moves across on the side arrows too, holding at the edges', () => {
    renderView();

    press('ArrowRight');
    expect(focusedId()).toBe('a1');
    press('ArrowRight');
    press('ArrowRight');
    expect(focusedId()).toBe('c1');
    press('ArrowLeft');
    press('ArrowLeft');
    expect(focusedId()).toBe('a1');
  });

  it('keeps J and K inside the focused column', () => {
    renderView();

    press('j');
    press('j');
    press('j');
    expect(focusedId()).toBe('a2');

    press('l');
    press('k');
    press('j');
    expect(focusedId()).toBe('c1');
  });

  it('opens labels on Shift+L and not on L', () => {
    renderView();

    press('j');
    press('l');
    expect(screen.queryByRole('dialog')).toBeNull();

    press('L', { shiftKey: true });
    expect(
      registry.list().find((shortcut) => shortcut.keys === 'shift+l')?.label
    ).toBe('Change labels');
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/labels/i);
  });

  it('lists the column keys under Board, H and L for the palette', () => {
    renderView();

    const board = registry
      .list()
      .filter((shortcut) => shortcut.group === 'Board')
      .map((shortcut) => [shortcut.keys, shortcut.scope, shortcut.label]);
    expect(board).toEqual(
      expect.arrayContaining([
        ['h', 'page', 'Previous column'],
        ['l', 'page', 'Next column'],
        ['arrowleft', 'global', 'Previous column'],
        ['arrowright', 'global', 'Next column'],
      ])
    );
  });

  it('binds no column keys on a list', () => {
    renderView('list');

    expect(
      registry.list().filter((shortcut) => shortcut.group === 'Board')
    ).toEqual([]);
    press('j');
    expect(
      registry.list().find((shortcut) => shortcut.keys === 'l')?.label
    ).toBe('Change labels');
  });
});
