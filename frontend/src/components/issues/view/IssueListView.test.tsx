/**
 * The list's own keys beyond movement and the pickers: that I assigns the
 * issue in focus to the signed in person, that Cmd or Ctrl+B flips the list to
 * a board, and that Cmd or Ctrl+. copies the focused issue's ID.
 */

import { act, render, screen } from '@testing-library/react';
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

/** One open issue with nobody on it. */
const issue: OrderedIssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
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
};

/** The lists the view resolves ids against, with the caller signed in. */
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
  people: [
    { user_id: 'user-1', email: 'me@example.com', display_name: 'Me' },
    { user_id: 'user-2', email: 'ada@example.com', display_name: 'Ada' },
  ],
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
let onStateChange: ReturnType<typeof vi.fn<(state: ViewState) => void>>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

/** Mounts the view over one issue, inside a shortcut registry. */
const renderView = () => {
  const collection: IssueCollection = {
    issues: [issue],
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
          onStateChange={onStateChange}
          collection={collection}
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

beforeEach(() => {
  registry = createShortcutRegistry();
  update = vi.fn<IssueCollection['update']>();
  onStateChange = vi.fn<(state: ViewState) => void>();
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IssueListView keys', () => {
  it('assigns the focused issue to the signed in person on I', () => {
    renderView();
    expect(screen.getByText('Cache the token')).toBeInTheDocument();

    press('j');
    press('i');

    expect(update).toHaveBeenCalledWith(['iss-1'], { assignee_id: 'user-1' });
  });

  it('does nothing on I with no issue in focus', () => {
    renderView();

    press('i');

    expect(update).not.toHaveBeenCalled();
  });

  it('switches the list to a board on Cmd or Ctrl+B', () => {
    renderView();

    press('b', { ctrlKey: true });

    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ layout: 'board', showEmpty: true })
    );
  });

  it('copies the focused issue ID on Cmd or Ctrl+.', () => {
    renderView();

    press('j');
    press('.', { ctrlKey: true });

    expect(writeText).toHaveBeenCalledWith('ENG-1');
  });

  it('copies the focused issue URL on Cmd or Ctrl+Shift+,', () => {
    renderView();

    press('j');
    press('<', { ctrlKey: true, shiftKey: true, code: 'Comma' });

    expect(writeText).toHaveBeenCalledWith(
      `${globalThis.location.origin}/w/mine/issues/ENG-1`
    );
  });
});
