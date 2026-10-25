/**
 * The list group header menu: Collapse all and Expand all fold every group,
 * or every sub-group inside one parent, Hide group drops a group into the
 * hidden groups row at the foot of the list, one click there brings it back,
 * Alt+click on a fold toggle folds or unfolds every group to match, and a
 * group hidden in the list is a hidden column on the board.
 */

import {
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from '@testing-library/react';
import React, { useCallback, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../../hooks/useShortcuts';
import {
  defaultViewState,
  type IssueContext,
  type ViewState,
} from '../../../lib/issueView';
import IssueListView, { type ListFoldControl } from './IssueListView';

vi.mock(
  '../../../hooks/useProjectStatuses',
  () => import('../../../test/projectStatuses')
);

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

/** What the harness reports each time the folded set changes. */
type Seen = (keys: ReadonlySet<string>) => void;

/**
 * The view with folds held the way a page holds them, a toggle for one key
 * and a setter for many, unless `own` leaves the view to its own folds.
 */
const Harness: React.FC<{
  state: ViewState;
  own?: boolean;
  seen?: Seen;
}> = ({ state, own = false, seen }) => {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const change = useCallback(
    (next: Set<string>) => {
      seen?.(next);
      setKeys(next);
    },
    [seen]
  );
  const folds: ListFoldControl = {
    collapsed: keys,
    onToggle: (key) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      change(next);
    },
    onSet: (named, folded) => {
      const next = new Set(keys);
      for (const key of named) {
        if (folded) next.add(key);
        else next.delete(key);
      }
      change(next);
    },
  };
  return (
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
      canEdit
      {...(own ? {} : { folds })}
    />
  );
};

/** Wraps the harness in a router and a shortcut registry. */
const wrap = (node: React.ReactNode): React.ReactElement => (
  <MemoryRouter>
    <ShortcutRegistryContext.Provider value={createShortcutRegistry()}>
      {node}
    </ShortcutRegistryContext.Provider>
  </MemoryRouter>
);

/** The list grouped by status, optionally sub-grouped by priority. */
const listState = (
  subGroupBy: ViewState['subGroupBy'] = 'none'
): ViewState => ({
  ...defaultViewState('list'),
  groupBy: 'status',
  subGroupBy,
  showEmpty: false,
});

/** The fold toggle of the group whose name leads its accessible name. */
const toggleOf = (name: string, scope: HTMLElement = document.body) =>
  within(scope).getByRole('button', {
    name: new RegExp(`^${name}`),
  });

/** Opens a group's "..." menu and picks an item from it. */
const pick = (
  group: string,
  item: string,
  scope: HTMLElement = document.body
): void => {
  fireEvent.click(
    within(scope).getByRole('button', { name: `Group options for ${group}` })
  );
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
};

describe('IssueListView group header menu', () => {
  it('collapses and expands every group from one header menu', () => {
    render(wrap(<Harness state={listState()} />));
    expect(toggleOf('Backlog')).toHaveAttribute('aria-expanded', 'true');
    expect(toggleOf('Doing')).toHaveAttribute('aria-expanded', 'true');

    pick('Backlog', 'Collapse all');
    expect(toggleOf('Backlog')).toHaveAttribute('aria-expanded', 'false');
    expect(toggleOf('Doing')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Issue a1')).not.toBeInTheDocument();
    expect(screen.queryByText('Issue c1')).not.toBeInTheDocument();

    pick('Doing', 'Expand all');
    expect(toggleOf('Backlog')).toHaveAttribute('aria-expanded', 'true');
    expect(toggleOf('Doing')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Issue c1')).toBeInTheDocument();
  });

  it('opens the same menu on a right click on the header', () => {
    render(wrap(<Harness state={listState()} />));
    fireEvent.contextMenu(toggleOf('Doing'));
    expect(
      screen.getByRole('menuitem', { name: 'Collapse all' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse all' }));
    expect(toggleOf('Backlog')).toHaveAttribute('aria-expanded', 'false');
    expect(toggleOf('Doing')).toHaveAttribute('aria-expanded', 'false');
  });

  it('folds and unfolds every group on Alt+click, matching the clicked one', () => {
    render(wrap(<Harness state={listState()} own />));

    fireEvent.click(toggleOf('Backlog'), { altKey: true });
    expect(toggleOf('Backlog')).toHaveAttribute('aria-expanded', 'false');
    expect(toggleOf('Doing')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggleOf('Doing'));
    expect(toggleOf('Doing')).toHaveAttribute('aria-expanded', 'true');
    expect(toggleOf('Backlog')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggleOf('Backlog'), { altKey: true });
    expect(toggleOf('Backlog')).toHaveAttribute('aria-expanded', 'true');
    expect(toggleOf('Doing')).toHaveAttribute('aria-expanded', 'true');
  });

  it('hides a group into the hidden groups row and brings it back', () => {
    render(wrap(<Harness state={listState()} />));

    pick('Backlog', 'Hide group');
    expect(
      screen.queryByRole('region', { name: 'Backlog' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Issue a1')).not.toBeInTheDocument();
    expect(screen.getByText('Issue c1')).toBeInTheDocument();

    pick('Doing', 'Hide group');
    fireEvent.click(screen.getByRole('button', { name: '2 hidden groups' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Backlog/ }));
    expect(screen.getByRole('region', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByText('Issue a1')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '1 hidden group' })
    ).toBeInTheDocument();
  });

  it('shows no hidden groups row while nothing is hidden', () => {
    render(wrap(<Harness state={listState()} />));
    expect(
      screen.queryByRole('button', { name: /hidden group/ })
    ).not.toBeInTheDocument();
  });

  it('hides a group as a board column, through the same folded set', () => {
    let latest: ReadonlySet<string> = new Set();
    const seen: Seen = (keys) => {
      latest = keys;
    };
    const view: RenderResult = render(
      wrap(<Harness state={listState()} seen={seen} />)
    );
    pick('Backlog', 'Hide group');
    expect([...latest].every((key) => key.startsWith('column/'))).toBe(true);
    expect(latest.size).toBe(1);

    view.rerender(
      wrap(
        <Harness
          state={{ ...listState(), layout: 'board', showEmpty: true }}
          seen={seen}
        />
      )
    );
    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    expect(within(rail).getByText('Backlog')).toBeInTheDocument();
  });

  it('acts on the sub-groups inside one parent from a sub-group header', () => {
    render(wrap(<Harness state={listState('priority')} />));
    const backlog = screen.getByRole('region', { name: 'Backlog' });
    const doing = screen.getByRole('region', { name: 'Doing' });

    pick('Urgent', 'Collapse all', backlog);
    expect(toggleOf('Urgent', backlog)).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(toggleOf('High', backlog)).toHaveAttribute('aria-expanded', 'false');
    expect(toggleOf('High', doing)).toHaveAttribute('aria-expanded', 'true');
    expect(toggleOf('Backlog')).toHaveAttribute('aria-expanded', 'true');

    pick('High', 'Hide group', doing);
    expect(screen.queryByText('Issue c1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 hidden group' }));
    expect(
      screen.getByRole('menuitem', { name: /Doing \/ High/ })
    ).toBeInTheDocument();
  });
});
