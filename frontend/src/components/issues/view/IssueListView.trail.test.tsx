/**
 * Opening an issue from a list remembers the list's order and address, which
 * is what lets the issue page step through it: a row click, Enter and Space
 * each record the trail, and a Shift+click that selects does not.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  type ShortcutRegistry,
} from '../../../hooks/useShortcuts';
import { clearTrail, readTrail } from '../../../lib/issueTrail';
import { defaultViewState, type IssueContext } from '../../../lib/issueView';
import IssueListView from './IssueListView';

const peekIssue = vi.fn();

vi.mock('../../../hooks/usePeekIssue', () => ({
  usePeekIssue: () => ({ peekIssue, peekedKey: null }),
}));

/** An open issue in the one team. */
const issueOf = (n: number, title: string): OrderedIssueRead => ({
  id: `iss-${String(n)}`,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${String(n)}`,
  number: n,
  title,
  body: null,
  status_id: 'st-1',
  priority: 'high',
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
  people: [],
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

/** Mounts a three issue list at a team address with a query string. */
const renderView = () => {
  const collection: IssueCollection = {
    issues: [
      issueOf(1, 'Cache the token'),
      issueOf(2, 'Rotate the keys'),
      issueOf(3, 'Trim the logs'),
    ],
    isLoading: false,
    error: null,
    truncated: false,
    queryKey: ['issues'],
    update: vi.fn(),
  };
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG?q=the']}>
      <ShortcutRegistryContext.Provider value={registry}>
        <Routes>
          <Route
            path="/w/mine/team/ENG"
            element={
              <IssueListView
                slug="mine"
                state={defaultViewState('list')}
                onStateChange={vi.fn()}
                collection={collection}
                lists={lists}
                scaleFor={() => 'off'}
                canEdit
              />
            }
          />
          <Route path="/w/mine/issues/:key" element={<p>Issue page</p>} />
        </Routes>
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** The keys in the order the list shows them. */
const shownKeys = (): string[] =>
  screen
    .getAllByRole('listitem')
    .map((row) => row.textContent?.match(/ENG-\d+/)?.[0] ?? '');

/** Feeds one key press to the registry, as the provider's listener would. */
const press = (key: string): void => {
  act(() => {
    registry.handleKey(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  });
};

beforeEach(() => {
  registry = createShortcutRegistry();
  peekIssue.mockReset();
  clearTrail();
});

describe('IssueListView trail', () => {
  it('remembers the order and address when a row is clicked', () => {
    renderView();
    const keys = shownKeys();

    fireEvent.click(screen.getByRole('link', { name: 'Rotate the keys' }));

    expect(readTrail()).toEqual({
      slug: 'mine',
      keys,
      from: '/w/mine/team/ENG?q=the',
    });
    expect(keys).toHaveLength(3);
    expect(screen.getByText('Issue page')).toBeInTheDocument();
  });

  it('remembers the order when Enter opens the focused row', () => {
    renderView();
    const keys = shownKeys();

    press('j');
    press('Enter');

    expect(readTrail()?.keys).toEqual(keys);
    expect(screen.getByText('Issue page')).toBeInTheDocument();
  });

  it('remembers the order when Space peeks, so opening from the peek keeps it', () => {
    renderView();

    press('j');
    press(' ');

    expect(peekIssue).toHaveBeenCalled();
    expect(readTrail()?.keys).toHaveLength(3);
  });

  it('records nothing for a Shift+click that selects', () => {
    renderView();

    fireEvent.click(screen.getByRole('link', { name: 'Rotate the keys' }), {
      shiftKey: true,
    });

    expect(readTrail()).toBeNull();
  });
});
