/**
 * Archive and the row menu in a list: # archives the issue in focus or the
 * selection and restores archived ones, a right click opens the row's
 * commands for that row or for the selection it belongs to, and the bulk bar
 * offers archive and delete beside the properties.
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

/** An open issue with the given number and title. */
const makeIssue = (
  number: number,
  title: string,
  archivedAt: string | null = null
): OrderedIssueRead => ({
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
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  archived_at: archivedAt,
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

const lists: IssueContextState = {
  context,
  forTeam: () => context,
  isLoading: false,
  createLabel: () => Promise.resolve(null),
};

let registry: ShortcutRegistry;
let update: ReturnType<typeof vi.fn<IssueCollection['update']>>;
let archive: ReturnType<typeof vi.fn<NonNullable<IssueCollection['archive']>>>;
let remove: ReturnType<typeof vi.fn<NonNullable<IssueCollection['remove']>>>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

/** Mounts the view over the given issues, inside a shortcut registry. */
const renderView = (
  issues: OrderedIssueRead[],
  state: ViewState = defaultViewState('list')
) => {
  const collection: IssueCollection = {
    issues,
    isLoading: false,
    error: null,
    truncated: false,
    queryKey: ['issues'],
    update,
    archive,
    remove,
  };
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={registry}>
        <IssueListView
          slug="mine"
          state={state}
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
  archive = vi.fn<NonNullable<IssueCollection['archive']>>(() =>
    Promise.resolve()
  );
  remove = vi.fn<NonNullable<IssueCollection['remove']>>(() =>
    Promise.resolve()
  );
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

describe('IssueListView archive', () => {
  it('archives the focused issue on #', () => {
    renderView([makeIssue(1, 'Cache the token')]);

    press('j');
    press('#', { shiftKey: true });

    expect(archive).toHaveBeenCalledWith(['iss-1'], false);
  });

  it('restores an archived issue on #', () => {
    renderView([makeIssue(1, 'Cache the token', '2026-09-20T00:00:00Z')], {
      ...defaultViewState('list'),
      showArchived: true,
    });
    expect(screen.getByText('Archived')).toBeInTheDocument();

    press('j');
    press('#', { shiftKey: true });

    expect(archive).toHaveBeenCalledWith(['iss-1'], true);
  });

  it('lists the archive command for the palette with its current label', () => {
    renderView([makeIssue(1, 'Cache the token')]);

    press('j');

    expect(
      registry
        .list()
        .some(
          (shortcut) =>
            shortcut.keys === '#' && shortcut.label === 'Archive issue'
        )
    ).toBe(true);
  });

  it('offers archive and delete on the bulk bar', () => {
    renderView([makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')]);

    press('j');
    press('x');
    press('j');
    press('x');
    const bar = screen.getByRole('toolbar', { name: 'Selected issues' });
    fireEvent.click(
      Array.from(bar.querySelectorAll('button')).find(
        (button) => button.textContent?.startsWith('Archive') === true
      ) as HTMLButtonElement
    );

    expect(archive).toHaveBeenCalledWith(['iss-1', 'iss-2'], false);
  });
});

describe('IssueListView row menu', () => {
  it('opens on a right click with the row commands and their keys', () => {
    renderView([makeIssue(1, 'Cache the token')]);

    rightClick('Cache the token');

    const menu = screen.getByRole('menu', { name: 'ENG-1 actions' });
    expect(menu).toBeInTheDocument();
    for (const name of [
      'Open issue',
      'Status',
      'Priority',
      'Assign to me',
      'Copy ID',
      'Archive',
      'Delete',
    ]) {
      expect(
        screen.getByRole('menuitem', { name: new RegExp(`^${name}`) })
      ).toBeInTheDocument();
    }
  });

  it('archives the row it was opened on', () => {
    renderView([makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')]);

    rightClick('Fix login');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Archive/ }));

    expect(archive).toHaveBeenCalledWith(['iss-2'], false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('acts on the selection when the row is part of it', () => {
    renderView([makeIssue(1, 'Cache the token'), makeIssue(2, 'Fix login')]);

    press('j');
    press('x');
    press('j');
    press('x');
    rightClick('Fix login');
    expect(screen.getByRole('menu', { name: '2 issues' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Copy ID/ }));

    expect(writeText).toHaveBeenCalledWith('ENG-1, ENG-2');
  });

  it('assigns the row to the signed in person from the menu', () => {
    renderView([makeIssue(1, 'Cache the token')]);

    rightClick('Cache the token');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Assign to me/ }));

    expect(update).toHaveBeenCalledWith(['iss-1'], { assignee_id: 'user-1' });
  });

  it('closes on Escape', () => {
    renderView([makeIssue(1, 'Cache the token')]);

    rightClick('Cache the token');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
