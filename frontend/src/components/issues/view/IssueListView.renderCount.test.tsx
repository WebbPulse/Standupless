/**
 * A long list stays cheap to point at. Moving the pointer or the keyboard
 * focus from row to row re-renders the row it left and the row it reached,
 * not every row in the view, so a team with hundreds of Done issues showing
 * does not redraw them all on each row the pointer crosses. Rows are counted
 * through the prefetch hook every row calls once per render.
 */

import { act, fireEvent, render } from '@testing-library/react';
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

const rowRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../../hooks/useIssuePrefetch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../hooks/useIssuePrefetch')>();
  return {
    ...actual,
    useIssuePrefetch: (key: string, focused?: boolean) => {
      rowRenders.count += 1;
      return actual.useIssuePrefetch(key, focused);
    },
  };
});

/** How many rows the list holds, most of them Done. */
const ROWS = 1000;

/** One issue, Done for all but every tenth. */
const make = (n: number): OrderedIssueRead => ({
  id: `iss-${String(n)}`,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${String(n)}`,
  number: n,
  title: `Issue ${String(n)}`,
  body: null,
  status_id: n % 10 === 0 ? 'st-todo' : 'st-done',
  priority: 'medium',
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

const issues: OrderedIssueRead[] = Array.from({ length: ROWS }, (_, index) =>
  make(index + 1)
);

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

const collection: IssueCollection = {
  issues,
  isLoading: false,
  error: null,
  truncated: false,
  queryKey: ['issues'],
  update: vi.fn<IssueCollection['update']>(),
};

const state = defaultViewState('list');
const onStateChange = vi.fn<(next: ViewState) => void>();
const scaleFor = () => 'off' as const;

let registry: ShortcutRegistry;
let listener: (event: KeyboardEvent) => void;

/** Mounts the list over every issue, grouped by status. */
const renderView = () =>
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={registry}>
        <IssueListView
          slug="mine"
          state={state}
          onStateChange={onStateChange}
          collection={collection}
          lists={lists}
          scaleFor={scaleFor}
          canEdit
        />
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );

/** The row element of one issue. */
const rowOf = (n: number): HTMLElement => {
  const row = document.querySelector<HTMLElement>(
    `[data-row-id="iss-${String(n)}"]`
  );
  if (row === null) throw new Error(`No row for iss-${String(n)}`);
  return row;
};

/** Whether a row draws the focus bar. */
const isFocused = (n: number): boolean =>
  rowOf(n).className.includes('before:bg-accent');

beforeEach(() => {
  window.localStorage.clear();
  rowRenders.count = 0;
  registry = createShortcutRegistry();
  listener = (event) => {
    registry.handleKey(event);
  };
  document.addEventListener('keydown', listener);
});

afterEach(() => {
  document.removeEventListener('keydown', listener);
});

describe('row render cost', () => {
  it('draws every row once on mount', () => {
    renderView();

    expect(document.querySelectorAll('[data-row-id]')).toHaveLength(ROWS);
    expect(rowRenders.count).toBeLessThanOrEqual(ROWS * 2);
  });

  it('re-renders only the rows the pointer leaves and reaches', () => {
    renderView();
    rowRenders.count = 0;

    const path = [11, 12, 13, 14, 15, 16, 17, 18, 19, 21];
    for (const n of path) {
      act(() => {
        fireEvent.mouseMove(rowOf(n));
      });
    }

    expect(isFocused(21)).toBe(true);
    expect(isFocused(19)).toBe(false);
    expect(rowRenders.count).toBeLessThanOrEqual(path.length * 2);
  });

  it('re-renders only two rows for each keyboard step', () => {
    renderView();
    act(() => {
      fireEvent.mouseMove(rowOf(11));
    });
    rowRenders.count = 0;

    const steps = 10;
    for (let step = 0; step < steps; step += 1) {
      act(() => {
        fireEvent.keyDown(document.body, { key: 'j' });
      });
    }

    expect(isFocused(11)).toBe(false);
    expect(rowRenders.count).toBeLessThanOrEqual(steps * 2);
  });
});
