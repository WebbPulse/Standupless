/**
 * The bulk bar's extra actions on a list selection: Cmd or Ctrl+Shift+M
 * opens the move dialog on every selected issue at once, and the More menu
 * subscribes the caller to the whole selection with one notice.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { clearToasts, currentToasts } from '../../../lib/toast';
import type { SubscribersRead, WorkspaceRead } from '../../../types/Api';
import IssueListView from './IssueListView';

const subscribe =
  vi.fn<(workspaceId: string, issueId: string) => Promise<SubscribersRead>>();

vi.mock('../../../api/notifications', async () => {
  const actual = await vi.importActual<
    typeof import('../../../api/notifications')
  >('../../../api/notifications');
  return {
    ...actual,
    subscribe: (workspaceId: string, issueId: string) =>
      subscribe(workspaceId, issueId),
  };
});

vi.mock('../MoveIssueDialog', async () => {
  const actual =
    await vi.importActual<typeof import('../MoveIssueDialog')>(
      '../MoveIssueDialog'
    );
  return {
    ...actual,
    SelectionMoveDialog: ({
      open,
      issues,
    }: {
      open: boolean;
      issues: readonly { key: string }[];
    }) =>
      open ? (
        <div role="dialog" aria-label="Move to team">
          {issues.map((issue) => issue.key).join(',')}
        </div>
      ) : null,
  };
});

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

const modShift = { ctrlKey: true, shiftKey: true };

beforeEach(() => {
  registry = createShortcutRegistry();
  update = vi.fn<IssueCollection['update']>();
  clearToasts();
  subscribe.mockReset();
  subscribe.mockResolvedValue({ subscribers: [], subscribed: true });
});

/** Selects the first two rows with j and x. */
const selectTwo = (): void => {
  press('j');
  press('x');
  press('j');
  press('x');
};

describe('IssueListView bulk actions', () => {
  it('opens the move dialog on the whole selection', () => {
    renderView([makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')]);

    selectTwo();
    press('M', modShift);

    expect(
      screen.getByRole('dialog', { name: 'Move to team' })
    ).toHaveTextContent('ENG-1,ENG-2');
  });

  it('does not open the move dialog without edit rights', () => {
    renderView(
      [makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')],
      false
    );

    selectTwo();
    press('M', modShift);

    expect(
      screen.queryByRole('dialog', { name: 'Move to team' })
    ).not.toBeInTheDocument();
  });

  it('subscribes to the selection from the More menu', async () => {
    const user = userEvent.setup();
    renderView([makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')]);

    selectTwo();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /^Subscribe/ }));

    await vi.waitFor(() => {
      expect(currentToasts().map((toast) => toast.message)).toContain(
        'Subscribed to 2 issues'
      );
    });
    expect(subscribe.mock.calls.map(([, id]) => id).sort()).toEqual([
      'iss-1',
      'iss-2',
    ]);
  });
});
