/**
 * The quick actions in a list: Cmd or Ctrl+Shift+C puts the focused issue
 * into its team's active cycle, Cmd or Ctrl+Shift+D clears the due date, Cmd
 * or Ctrl+Shift+L clears the labels of a whole selection in one write, and
 * the actions are listed for the palette and the shortcuts panel.
 */

import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import {
  ADD_TO_ACTIVE_CYCLE_LABEL,
  REMOVE_DUE_DATE_LABEL,
  REMOVE_LABELS_LABEL,
} from '../../../hooks/useQuickActions';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  type ShortcutRegistry,
} from '../../../hooks/useShortcuts';
import { defaultViewState, type IssueContext } from '../../../lib/issueView';
import type { CycleRead } from '../../../types/Api';
import IssueListView from './IssueListView';

/** An open issue of team-1 numbered as given, overridden. */
const makeIssue = (
  number: number,
  overrides: Partial<OrderedIssueRead> = {}
): OrderedIssueRead => ({
  id: `iss-${String(number)}`,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${String(number)}`,
  number,
  title: `Issue ${String(number)}`,
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
  ...overrides,
});

const activeCycle = {
  cycle_id: 'cy-now',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  name: 'Cycle 7',
  start_date: '2026-10-19',
  end_date: '2026-11-01',
  goal: null,
  cancelled: false,
  status: 'active',
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
} as CycleRead;

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
  labels: [
    { id: 'lb-1', name: 'Bug', color: '#f00', team_id: 'team-1' },
    { id: 'lb-2', name: 'Infra', color: '#0f0', team_id: 'team-1' },
  ],
  people: [{ user_id: 'user-1', email: 'me@example.com', display_name: 'Me' }],
  projects: [],
  cycles: [activeCycle],
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

/** Mounts the view over the given issues, inside a shortcut registry. */
const renderView = (issues: OrderedIssueRead[]) => {
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

const modShift = { ctrlKey: true, shiftKey: true };

beforeEach(() => {
  registry = createShortcutRegistry();
  update = vi.fn<IssueCollection['update']>();
});

describe('IssueListView quick actions', () => {
  it('adds the focused issue to the active cycle on Cmd or Ctrl+Shift+C', async () => {
    renderView([makeIssue(1)]);

    press('j');
    press('C', modShift);

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(['iss-1'], { cycle_id: 'cy-now' });
    });
  });

  it('clears the due date on Cmd or Ctrl+Shift+D', () => {
    renderView([makeIssue(1, { due_date: '2026-11-01' })]);

    press('j');
    press('D', modShift);

    expect(update).toHaveBeenCalledWith(['iss-1'], { due_date: null });
  });

  it('clears the labels of the selection in one write on Cmd or Ctrl+Shift+L', () => {
    renderView([
      makeIssue(1, { label_ids: ['lb-1'] }),
      makeIssue(2, { label_ids: ['lb-1', 'lb-2'] }),
    ]);

    press('j');
    press('x');
    press('j');
    press('x');
    press('L', modShift);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(['iss-1', 'iss-2'], {
      remove_label_ids: ['lb-1', 'lb-2'],
    });
  });

  it('lists the quick actions for the palette while they apply', () => {
    renderView([makeIssue(1, { due_date: '2026-11-01', label_ids: ['lb-1'] })]);

    press('j');

    const labels = registry
      .list()
      .filter((shortcut) => shortcut.scope === 'issue')
      .map((shortcut) => shortcut.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        ADD_TO_ACTIVE_CYCLE_LABEL,
        REMOVE_DUE_DATE_LABEL,
        REMOVE_LABELS_LABEL,
      ])
    );
  });

  it('keeps Shift+L off the quick label removal', () => {
    renderView([makeIssue(1, { label_ids: ['lb-1'] })]);

    press('j');
    press('L', { shiftKey: true });

    expect(update).not.toHaveBeenCalled();
  });
});
