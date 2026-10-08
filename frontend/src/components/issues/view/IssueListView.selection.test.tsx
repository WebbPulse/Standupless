/**
 * Bulk selection on the list: a section header selects or clears its whole
 * section, folded or not, and shows a partial selection as indeterminate;
 * shift-click selects a range; x, shift+arrow, Cmd or Ctrl+A and Escape work
 * from the keyboard, including while a checkbox holds focus; and the bulk bar
 * counts and acts on every selected issue.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** One issue in a status at a priority, so the order is known. */
const make = (
  n: number,
  status: string,
  priority: OrderedIssueRead['priority']
): OrderedIssueRead => ({
  id: `iss-${String(n)}`,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${String(n)}`,
  number: n,
  title: `Issue ${String(n)}`,
  body: null,
  status_id: status,
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

const issues: OrderedIssueRead[] = [
  make(1, 'st-todo', 'urgent'),
  make(2, 'st-todo', 'high'),
  make(3, 'st-todo', 'low'),
  make(4, 'st-done', 'high'),
];

const context: IssueContext = {
  statuses: [
    {
      id: 'st-todo',
      name: 'Todo',
      category: 'unstarted',
      position: 0,
      team_id: 'team-1',
    },
    {
      id: 'st-done',
      name: 'Done',
      category: 'completed',
      position: 1,
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
let listener: (event: KeyboardEvent) => void;

/** Mounts the list over the four issues, grouped by status. */
const renderView = () => {
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
          state={defaultViewState('list')}
          onStateChange={vi.fn<(state: ViewState) => void>()}
          collection={collection}
          lists={lists}
          scaleFor={() => 'off'}
          canEdit
        />
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** Presses a key on the page, as the provider's listener would see it. */
const press = (key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });
};

const row = (key: string): HTMLInputElement =>
  screen.getByRole('checkbox', { name: `Select ${key}` });

const header = (label: string): HTMLInputElement =>
  screen.getByRole('checkbox', { name: `Select all in ${label}` });

const selectedKeys = (): string[] =>
  screen
    .queryAllByRole('checkbox')
    .filter(
      (box): box is HTMLInputElement =>
        box instanceof HTMLInputElement &&
        box.checked &&
        (box.getAttribute('aria-label') ?? '').startsWith('Select ENG-')
    )
    .map((box) => (box.getAttribute('aria-label') ?? '').slice(7));

const count = (): string | null =>
  screen.queryByRole('toolbar', { name: 'Selected issues' })?.textContent ??
  null;

beforeEach(() => {
  window.localStorage.clear();
  registry = createShortcutRegistry();
  update = vi.fn<IssueCollection['update']>();
  listener = (event) => {
    registry.handleKey(event);
  };
  document.addEventListener('keydown', listener);
});

afterEach(() => {
  document.removeEventListener('keydown', listener);
  vi.restoreAllMocks();
});

describe('section select-all', () => {
  it('selects and clears a whole section from its header', () => {
    renderView();

    fireEvent.click(header('Todo'));

    expect(selectedKeys()).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
    expect(header('Todo').checked).toBe(true);
    expect(count()).toContain('3 selected');

    fireEvent.click(header('Todo'));

    expect(selectedKeys()).toEqual([]);
    expect(count()).toBeNull();
  });

  it('shows a partial section as indeterminate and completes it', () => {
    renderView();

    fireEvent.click(row('ENG-2'));

    expect(header('Todo').indeterminate).toBe(true);
    expect(header('Todo').checked).toBe(false);
    expect(header('Todo')).toHaveAttribute('aria-checked', 'mixed');
    expect(header('Done').indeterminate).toBe(false);

    fireEvent.click(header('Todo'));

    expect(header('Todo').indeterminate).toBe(false);
    expect(selectedKeys()).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
  });

  it('selects a folded section and the bulk actions reach it', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /^Todo/ }));
    expect(screen.queryByText('Issue 1')).not.toBeInTheDocument();

    fireEvent.click(header('Todo'));
    expect(count()).toContain('3 selected');

    press('i');

    expect(update).toHaveBeenCalledWith(['iss-1', 'iss-2', 'iss-3'], {
      assignee_id: 'user-1',
    });
  });
});

describe('row selection', () => {
  it('selects a range on shift-click', () => {
    renderView();

    fireEvent.click(row('ENG-1'));
    fireEvent.click(row('ENG-4'), { shiftKey: true });

    expect(selectedKeys()).toEqual(['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4']);
    expect(count()).toContain('4 selected');
  });

  it('toggles the focused issue on x', () => {
    renderView();
    press('j');

    press('x');
    expect(selectedKeys()).toEqual(['ENG-1']);

    press('x');
    expect(selectedKeys()).toEqual([]);
  });

  it('extends the selection with shift and the arrows', () => {
    renderView();
    press('j');

    press('ArrowDown', { shiftKey: true });
    press('ArrowDown', { shiftKey: true });

    expect(selectedKeys()).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);

    press('ArrowUp', { shiftKey: true });

    expect(count()).toContain('3 selected');
  });

  it('selects every visible issue on Cmd or Ctrl+A and clears on Escape', () => {
    renderView();

    press('a', { ctrlKey: true });
    expect(selectedKeys()).toEqual(['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4']);

    press('Escape');
    expect(selectedKeys()).toEqual([]);

    press('a', { metaKey: true });
    expect(count()).toContain('4 selected');
  });

  it('keeps the keys working while a checkbox holds focus', () => {
    renderView();
    const box = row('ENG-2');
    fireEvent.click(box);
    box.focus();

    act(() => {
      fireEvent.keyDown(box, { key: 'a', ctrlKey: true });
    });
    expect(count()).toContain('4 selected');

    act(() => {
      fireEvent.keyDown(box, { key: 'Escape' });
    });
    expect(count()).toBeNull();
  });
});
