/**
 * Relations and the branch name from a list: M then B, X, R or D opens the
 * relation dialog on the focused issue starting on that relation, and the row
 * menu offers the same relations and copies the git branch name, for one
 * issue only.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../../contexts/WorkspaceContextDefinition';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  type ShortcutRegistry,
} from '../../../hooks/useShortcuts';
import { defaultViewState, type IssueContext } from '../../../lib/issueView';
import type { WorkspaceRead } from '../../../types/Api';
import IssueListView from './IssueListView';

vi.mock('../AddRelationDialog', () => ({
  default: ({
    issueId,
    open,
    initialType,
  }: {
    issueId: string;
    open: boolean;
    initialType?: string;
  }) =>
    open ? (
      <div role="dialog" aria-label="Add relation">
        {`${issueId}:${initialType ?? ''}`}
      </div>
    ) : null,
}));

vi.mock('../../../hooks/useIssuePrefetch', () => ({
  useIssuePrefetch: () => ({
    onMouseEnter: () => undefined,
    onMouseLeave: () => undefined,
    onFocus: () => undefined,
    onBlur: () => undefined,
  }),
}));

/**
 * An open issue with the given number and title, created earlier the higher
 * its number so priority ordering keeps the rows in number order.
 */
const makeIssue = (number: number, title: string): OrderedIssueRead => ({
  id: `iss-${String(number)}`,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${String(number)}`,
  number,
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
  created_at: `2026-09-${String(20 - number).padStart(2, '0')}T00:00:00Z`,
  updated_at: '2026-09-17T00:00:00Z',
  archived_at: null,
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
  people: [{ user_id: 'user-1', email: 'me@example.com', display_name: 'Me' }],
  projects: [],
  cycles: [],
  currentUserId: 'user-1',
};

const workspace: WorkspaceContextType = {
  workspace: { id: 'ws-1', slug: 'acme' } as WorkspaceRead,
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
};

const lists: IssueContextState = {
  context,
  forTeam: () => context,
  isLoading: false,
  createLabel: () => Promise.resolve(null),
};

let registry: ShortcutRegistry;
let update: ReturnType<typeof vi.fn<IssueCollection['update']>>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

/**
 * Mounts the view over the given issues inside a shortcut registry and a
 * resolved workspace.
 */
const renderView = (issues: OrderedIssueRead[], canEdit = true) => {
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
      <WorkspaceContext.Provider value={workspace}>
        <ShortcutRegistryContext.Provider value={registry}>
          <IssueListView
            slug="mine"
            state={defaultViewState('list')}
            onStateChange={() => undefined}
            collection={collection}
            lists={lists}
            scaleFor={() => 'off'}
            canEdit={canEdit}
          />
        </ShortcutRegistryContext.Provider>
      </WorkspaceContext.Provider>
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

/** Right clicks the row holding the given title. */
const rightClick = (title: string): void => {
  const row = screen.getByText(title).closest('li');
  if (row === null) throw new Error(`no row for ${title}`);
  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
};

beforeEach(() => {
  registry = createShortcutRegistry();
  update = vi.fn<IssueCollection['update']>();
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

describe('IssueListView relation keys', () => {
  it.each([
    ['b', 'blocked_by'],
    ['x', 'blocks'],
    ['r', 'relates_to'],
    ['d', 'duplicate_of'],
  ])('opens the relation dialog on M then %s', (key, type) => {
    renderView([makeIssue(1, 'Cache the token')]);

    press('j');
    press('m');
    press(key);

    expect(
      screen.getByRole('dialog', { name: 'Add relation' })
    ).toHaveTextContent(`iss-1:${type}`);
  });

  it('does nothing with no issue in focus', () => {
    renderView([makeIssue(1, 'Cache the token')]);

    press('m');
    press('b');

    expect(
      screen.queryByRole('dialog', { name: 'Add relation' })
    ).not.toBeInTheDocument();
  });

  it('does nothing on a selection of several issues', () => {
    renderView([makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')]);

    press('j');
    press('x');
    press('j');
    press('x');
    press('m');
    press('b');

    expect(
      screen.queryByRole('dialog', { name: 'Add relation' })
    ).not.toBeInTheDocument();
  });

  it('does nothing without edit rights', () => {
    renderView([makeIssue(1, 'Cache the token')], false);

    press('j');
    press('m');
    press('b');

    expect(
      screen.queryByRole('dialog', { name: 'Add relation' })
    ).not.toBeInTheDocument();
  });

  it('lists the relation and branch commands for the palette', () => {
    renderView([makeIssue(1, 'Cache the token')]);

    press('j');

    const labels = registry.list().map((shortcut) => shortcut.label);
    expect(labels).toContain('Mark as blocked by…');
    expect(labels).toContain('Copy git branch name');
  });
});

describe('IssueListView row menu relations', () => {
  it('marks a relation from the row menu', () => {
    renderView([makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')]);

    rightClick('Fix login');
    fireEvent.click(
      screen.getByRole('menuitem', { name: /^Mark as related to/ })
    );

    expect(
      screen.getByRole('dialog', { name: 'Add relation' })
    ).toHaveTextContent('iss-2:relates_to');
  });

  it('copies the git branch name from the row menu', () => {
    renderView([makeIssue(1, 'Cache the token')]);

    rightClick('Cache the token');
    fireEvent.click(
      screen.getByRole('menuitem', { name: /^Copy git branch name/ })
    );

    expect(writeText).toHaveBeenCalledWith('eng-1-cache-the-token');
  });

  it('leaves relations and the branch name off a selection menu', () => {
    renderView([makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')]);

    press('j');
    press('x');
    press('j');
    press('x');
    rightClick('Fix login');

    expect(screen.getByRole('menu', { name: '2 issues' })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: /^Mark as/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: /^Copy git branch name/ })
    ).not.toBeInTheDocument();
  });
});
