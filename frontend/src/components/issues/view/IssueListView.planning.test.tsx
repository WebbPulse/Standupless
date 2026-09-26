/**
 * The list's planning and delete keys: Shift+C moves the issue in focus to a
 * cycle of its own team, Shift+P to a project linked to its team, Shift+D sets
 * its due date, and Cmd or Ctrl+Backspace deletes it after a confirmation that
 * Enter accepts and Escape dismisses.
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
  type IssueChange,
  type IssueContext,
} from '../../../lib/issueView';
import type { CycleRead, ProjectRead } from '../../../types/Api';
import IssueListView from './IssueListView';

/** One open issue with no plan yet. */
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

const counts = { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 };

/** A cycle in the given team with the given status. */
const cycle = (
  id: string,
  name: string,
  teamId: string,
  status: CycleRead['status']
): CycleRead => ({
  cycle_id: id,
  workspace_id: 'ws-1',
  team_id: teamId,
  name,
  start_date: '2026-09-21',
  end_date: '2026-10-04',
  goal: null,
  cancelled: false,
  status,
  counts,
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
});

/** A project linked to the given teams. */
const project = (id: string, name: string, teamIds: string[]): ProjectRead => ({
  project_id: id,
  workspace_id: 'ws-1',
  team_id: teamIds[0] ?? '',
  team_ids: teamIds,
  name,
  description: null,
  lead_id: null,
  start_date: null,
  target_date: null,
  status: 'in_progress',
  counts,
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
  people: [{ user_id: 'user-1', email: 'me@example.com', display_name: 'Me' }],
  projects: [
    project('pr-1', 'Token service', ['team-1']),
    project('pr-2', 'Billing', ['team-2']),
  ],
  cycles: [
    cycle('cy-1', 'Cycle 12', 'team-1', 'active'),
    cycle('cy-0', 'Cycle 11', 'team-1', 'completed'),
    cycle('cy-9', 'Other team cycle', 'team-2', 'active'),
  ],
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
let remove: ReturnType<typeof vi.fn<(ids: readonly string[]) => Promise<void>>>;

/** Mounts the view over one issue, inside a shortcut registry. */
const renderView = (withRemove = true) => {
  const collection: IssueCollection = {
    issues: [issue],
    isLoading: false,
    error: null,
    truncated: false,
    queryKey: ['issues'],
    update,
    ...(withRemove ? { remove } : {}),
  };
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={registry}>
        <IssueListView
          slug="mine"
          state={defaultViewState('list')}
          onStateChange={vi.fn()}
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

/** The change the last write asked of the issue in focus. */
const lastChange = (): IssueChange | null => {
  const call = update.mock.calls.at(-1);
  if (call === undefined) return null;
  const [ids, change] = call;
  expect(ids).toEqual(['iss-1']);
  return typeof change === 'function' ? change(issue) : change;
};

beforeEach(() => {
  registry = createShortcutRegistry();
  update = vi.fn<IssueCollection['update']>();
  remove = vi.fn<(ids: readonly string[]) => Promise<void>>(() =>
    Promise.resolve()
  );
});

describe('IssueListView planning keys', () => {
  it('moves the focused issue to one of its team cycles on Shift+C', () => {
    renderView();
    press('j');
    press('C', { shiftKey: true });

    const dialog = screen.getByRole('dialog', { name: /Move to cycle, ENG-1/ });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /No cycle/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Cycle 11/ })).toBeNull();
    expect(
      screen.queryByRole('option', { name: /Other team cycle/ })
    ).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: /Cycle 12/ }));

    expect(lastChange()).toEqual({ cycle_id: 'cy-1' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves the focused issue to a project linked to its team on Shift+P', () => {
    renderView();
    press('j');
    press('P', { shiftKey: true });

    expect(
      screen.getByRole('dialog', { name: /Move to project, ENG-1/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Billing/ })).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: /Token service/ }));

    expect(lastChange()).toEqual({ project_id: 'pr-1' });
  });

  it('sets the due date of the focused issue on Shift+D', () => {
    renderView();
    press('j');
    press('D', { shiftKey: true });

    expect(
      screen.getByRole('dialog', { name: /Set due date, ENG-1/ })
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Custom date'), {
      target: { value: '2026-10-09' },
    });

    expect(lastChange()).toEqual({ due_date: '2026-10-09' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves Shift+C alone with nothing in focus', () => {
    renderView();
    press('C', { shiftKey: true });

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('IssueListView delete key', () => {
  it('asks before deleting and deletes on Enter', async () => {
    renderView();
    press('j');
    press('Backspace', { ctrlKey: true });

    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(
      screen.getByRole('dialog', { name: 'Delete issue?' })
    ).toBeInTheDocument();
    expect(confirm).toHaveFocus();

    await act(async () => {
      fireEvent.submit(confirm.closest('form') as HTMLFormElement);
      await Promise.resolve();
    });

    expect(remove).toHaveBeenCalledWith(['iss-1']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancels on Escape without deleting', () => {
    renderView();
    press('j');
    press('Backspace', { metaKey: true });
    expect(
      screen.getByRole('dialog', { name: 'Delete issue?' })
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('offers no delete when the collection cannot delete', () => {
    renderView(false);
    press('j');
    press('Backspace', { ctrlKey: true });

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
