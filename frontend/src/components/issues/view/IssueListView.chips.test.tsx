/**
 * The chips on a row or card act on a click: a project or cycle chip opens
 * its page, a label or estimate chip narrows the view, and a viewer who cannot
 * edit narrows by priority, status or assignee too. None of them opens the
 * issue under it, by pointer or by Enter.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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
  type FilterField,
  type IssueContext,
  type ViewState,
} from '../../../lib/issueView';
import { cyclePath, projectPath } from '../../../lib/paths';
import type { CycleRead, ProjectRead } from '../../../types/Api';
import IssueListView from './IssueListView';

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
  assignee_id: 'user-2',
  label_ids: ['lb-bug'],
  estimate: 'M',
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: 'cy-1',
  project_id: 'proj-1',
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

const context: IssueContext = {
  statuses: [
    {
      id: 'st-1',
      name: 'Todo',
      category: 'unstarted',
      position: 0,
      team_id: 'team-1',
    },
    {
      id: 'st-2',
      name: 'Todo',
      category: 'unstarted',
      position: 0,
      team_id: 'team-2',
    },
  ],
  labels: [{ id: 'lb-bug', name: 'bug', color: '#f00', team_id: 'team-1' }],
  people: [
    { user_id: 'user-1', email: 'me@example.com', display_name: 'Me' },
    { user_id: 'user-2', email: 'ada@example.com', display_name: 'Ada' },
  ],
  projects: [
    {
      project_id: 'proj-1',
      team_id: 'team-1',
      team_ids: ['team-1'],
      name: 'Launch',
    } as ProjectRead,
  ],
  cycles: [
    { cycle_id: 'cy-1', team_id: 'team-1', name: 'Cycle 12' } as CycleRead,
  ],
  currentUserId: 'user-1',
};

const lists: IssueContextState = {
  context,
  forTeam: () => context,
  isLoading: false,
  createLabel: () => Promise.resolve(null),
};

const LIST = '/w/mine/team/ENG/issues';

let registry: ShortcutRegistry;
let onStateChange: ReturnType<typeof vi.fn<(state: ViewState) => void>>;
let listener: (event: KeyboardEvent) => void;

/** Shows where the router is, so a test can tell a chip from the row. */
const Where = () => {
  const location = useLocation();
  return (
    <output data-testid="where">
      {`${location.pathname}${location.search}`}
    </output>
  );
};

interface Options {
  layout?: 'list' | 'board';
  canEdit?: boolean;
  filterFields?: FilterField[];
}

/** Mounts the view over one issue with project and cycle shown. */
const renderView = ({
  layout = 'list',
  canEdit = true,
  filterFields,
}: Options = {}) => {
  const collection: IssueCollection = {
    issues: [issue],
    isLoading: false,
    error: null,
    truncated: false,
    queryKey: ['issues'],
    update: vi.fn<IssueCollection['update']>(),
  };
  const base = defaultViewState(layout);
  const state: ViewState = { ...base, visible: [...base.visible, 'cycle'] };
  render(
    <MemoryRouter initialEntries={[LIST]}>
      <ShortcutRegistryContext.Provider value={registry}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Where />
                <IssueListView
                  slug="mine"
                  state={state}
                  onStateChange={onStateChange}
                  collection={collection}
                  lists={lists}
                  scaleFor={() => 'tshirt'}
                  canEdit={canEdit}
                  filterFields={filterFields}
                />
              </>
            }
          />
        </Routes>
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

const where = (): string => screen.getByTestId('where').textContent ?? '';

/** The filters the last state change carried. */
const lastFilters = (): ViewState['filters'] => {
  const call = onStateChange.mock.calls.at(-1);
  if (call === undefined) throw new Error('no state change');
  return call[0].filters;
};

beforeEach(() => {
  registry = createShortcutRegistry();
  onStateChange = vi.fn<(state: ViewState) => void>();
  listener = (event) => {
    registry.handleKey(event);
  };
  document.addEventListener('keydown', listener);
});

afterEach(() => {
  document.removeEventListener('keydown', listener);
  vi.restoreAllMocks();
});

describe.each(['list', 'board'] as const)('chips on the %s', (layout) => {
  it('filters by a label without opening the issue', () => {
    renderView({ layout });

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter by label: bug' })
    );

    expect(lastFilters()).toEqual([
      { field: 'label', op: 'is', values: ['lb-bug'] },
    ]);
    expect(where()).toBe(LIST);
  });

  it('filters by an estimate', () => {
    renderView({ layout });

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter by estimate: M' })
    );

    expect(lastFilters()).toEqual([
      { field: 'estimate', op: 'is', values: ['M'] },
    ]);
    expect(where()).toBe(LIST);
  });

  it('opens the project page from the project chip', () => {
    renderView({ layout });

    fireEvent.click(screen.getByRole('link', { name: 'Open project: Launch' }));

    expect(where()).toBe(projectPath('mine', 'proj-1', 'ENG'));
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('opens the cycle page from the cycle chip', () => {
    renderView({ layout });

    fireEvent.click(screen.getByRole('link', { name: 'Open cycle: Cycle 12' }));

    expect(where()).toBe(cyclePath('mine', 'ENG', 'cy-1'));
  });
});

describe('chip keys and limits', () => {
  it('keeps Enter on a focused chip from opening the focused issue', () => {
    renderView();
    fireEvent.keyDown(document.body, { key: 'j' });
    const chip = screen.getByRole('button', { name: 'Filter by label: bug' });
    chip.focus();

    fireEvent.keyDown(chip, { key: 'Enter' });

    expect(where()).toBe(LIST);
  });

  it('opens the focused issue on Enter away from a chip', () => {
    renderView();
    fireEvent.keyDown(document.body, { key: 'j' });

    fireEvent.keyDown(document.body, { key: 'Enter' });

    expect(where()).toBe('/w/mine/issues/ENG-1');
  });

  it('leaves a chip inert for a field the view cannot filter on', () => {
    renderView({ filterFields: ['status'] });

    expect(
      screen.queryByRole('button', { name: 'Filter by label: bug' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
  });

  it('keeps the pickers for an editor', () => {
    renderView();

    expect(
      screen.queryByRole('button', { name: 'Filter by priority: High' })
    ).not.toBeInTheDocument();
  });

  it('filters by priority, status and assignee for a viewer', () => {
    renderView({ canEdit: false });

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter by priority: High' })
    );
    expect(lastFilters()).toEqual([
      { field: 'priority', op: 'is', values: ['high'] },
    ]);

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter by status: Todo' })
    );
    expect(lastFilters()).toEqual([
      { field: 'status', op: 'is', values: ['st-1', 'st-2'] },
    ]);

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter by assignee: Ada' })
    );
    expect(lastFilters()).toEqual([
      { field: 'assignee', op: 'is', values: ['user-2'] },
    ]);
    expect(where()).toBe(LIST);
  });
});
