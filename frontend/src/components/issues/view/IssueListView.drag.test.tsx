/**
 * Dragging list rows: a drop inside a group writes a manual position and
 * switches the view to manual ordering, a drop in another group sets the
 * grouped property, a drop on a folded group header moves the row into that
 * group, a drag on a selected row carries the whole selection in one write
 * with a count badge, and a press on a checkbox does not start a drag.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../../hooks/useShortcuts';
import {
  defaultViewState,
  type IssueChange,
  type IssueContext,
  type ViewState,
} from '../../../lib/issueView';
import IssueListView from './IssueListView';

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

let update: ReturnType<typeof vi.fn<IssueCollection['update']>>;
let onStateChange: ReturnType<typeof vi.fn<(state: ViewState) => void>>;

/** The list grouped by status. */
const listState = (overrides: Partial<ViewState> = {}): ViewState => ({
  ...defaultViewState('list'),
  groupBy: 'status',
  subGroupBy: 'none',
  showEmpty: false,
  ...overrides,
});

/** Mounts the list view with a mocked write path. */
const renderView = (state: ViewState = listState()) => {
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={createShortcutRegistry()}>
        <IssueListView
          slug="mine"
          state={state}
          onStateChange={onStateChange}
          collection={{
            issues,
            isLoading: false,
            error: null,
            truncated: false,
            queryKey: ['issues'],
            update,
          }}
          lists={lists}
          scaleFor={() => 'off'}
          canEdit
        />
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** The row of an issue. */
const row = (id: string): HTMLElement => {
  const found = screen.getByText(`Issue ${id}`).closest('li');
  if (found === null) throw new Error(`no row for ${id}`);
  return found;
};

/** A stand in for the browser's drag data. */
const transfer = () => ({
  setData: vi.fn(),
  getData: vi.fn(),
  setDragImage: vi.fn<(image: Element, x: number, y: number) => void>(),
  effectAllowed: 'all',
  dropEffect: 'none',
});

/**
 * Drags a row onto another, landing in its top half, or its bottom half with
 * `below`, and drops it on the list holding it.
 */
const dragTo = (
  from: HTMLElement,
  onto: HTMLElement,
  below = false,
  data = transfer()
) => {
  fireEvent.dragStart(from, { dataTransfer: data });
  vi.spyOn(onto, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    bottom: 20,
    height: 20,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent.dragOver(onto, { dataTransfer: data, clientY: below ? 15 : 5 });
  fireEvent.drop(onto.closest('ul') ?? onto, { dataTransfer: data });
};

/** The change the last write made to one issue. */
const changeFor = (id: string): IssueChange | null => {
  const call = update.mock.calls.at(-1);
  if (call === undefined) throw new Error('nothing was written');
  const [, change] = call;
  const issue = issues.find((item) => item.id === id);
  if (issue === undefined) throw new Error(`no issue ${id}`);
  return typeof change === 'function' ? change(issue) : change;
};

beforeEach(() => {
  update = vi.fn<IssueCollection['update']>();
  onStateChange = vi.fn<(state: ViewState) => void>();
});

describe('dragging list rows', () => {
  it('reorders inside a group with a manual position and manual ordering', () => {
    renderView();

    dragTo(row('a2'), row('a1'));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toEqual(['a2']);
    const placed = changeFor('a2');
    expect(Object.keys(placed ?? {})).toEqual(['sort_order']);
    expect(typeof placed?.sort_order).toBe('string');
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ ordering: 'manual', reverse: false })
    );
  });

  it('draws a line where the row would land', () => {
    renderView();
    const data = transfer();

    fireEvent.dragStart(row('a2'), { dataTransfer: data });
    vi.spyOn(row('a1'), 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 20,
      height: 20,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.dragOver(row('a1'), { dataTransfer: data, clientY: 5 });

    const list = screen.getByRole('list', { name: 'Backlog' });
    const indicator = list.querySelector('[data-drop-indicator]');
    expect(indicator).not.toBeNull();
    expect(indicator?.nextElementSibling).toBe(row('a1'));
  });

  it('sets the grouped property when a row lands in another group', () => {
    renderView();

    dragTo(row('a1'), row('c1'), true);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toEqual(['a1']);
    expect(changeFor('a1')).toEqual({ status_id: 'st-c' });
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('moves a row into a folded group dropped on its header', () => {
    renderView();
    const toggle = screen.getByRole('button', { name: /^Doing/ });
    fireEvent.click(toggle);
    expect(screen.queryByText('Issue c1')).not.toBeInTheDocument();
    const header = toggle.parentElement;
    if (header === null) throw new Error('no header');
    const data = transfer();

    fireEvent.dragStart(row('a1'), { dataTransfer: data });
    fireEvent.dragOver(header, { dataTransfer: data });
    expect(header).toHaveAttribute('data-drop-target');
    fireEvent.drop(header, { dataTransfer: data });

    expect(update).toHaveBeenCalledTimes(1);
    expect(changeFor('a1')).toEqual({ status_id: 'st-c' });
  });

  it('places a row at the end of a folded group in manual ordering', () => {
    renderView(listState({ ordering: 'manual' }));
    const toggle = screen.getByRole('button', { name: /^Doing/ });
    fireEvent.click(toggle);
    const header = toggle.parentElement;
    if (header === null) throw new Error('no header');
    const data = transfer();

    fireEvent.dragStart(row('a1'), { dataTransfer: data });
    fireEvent.dragOver(header, { dataTransfer: data });
    fireEvent.drop(header, { dataTransfer: data });

    const placed = changeFor('a1');
    expect(placed?.status_id).toBe('st-c');
    expect(typeof placed?.sort_order).toBe('string');
  });

  it('carries the whole selection in one write with a count badge', () => {
    renderView();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select ENG-a1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select ENG-a2' }));
    const data = transfer();

    dragTo(row('a1'), row('c1'), true, data);

    expect(data.setDragImage).toHaveBeenCalledTimes(1);
    const ghost = data.setDragImage.mock.calls[0]?.[0];
    if (!(ghost instanceof HTMLElement)) throw new Error('no drag image');
    expect(within(ghost).getByText('2 issues')).toBeInTheDocument();
    expect(update).toHaveBeenCalledTimes(1);
    const [ids, , options] = update.mock.calls[0] ?? [];
    expect(ids).toEqual(['a1', 'a2']);
    expect(changeFor('a1')).toEqual({ status_id: 'st-c' });
    expect(changeFor('a2')).toEqual({ status_id: 'st-c' });
    expect(options).toEqual({ message: 'Moved 2 issues to Doing' });
  });

  it('does not start a drag from a press on the checkbox', () => {
    renderView();
    fireEvent.pointerDown(
      screen.getByRole('checkbox', { name: 'Select ENG-a1' })
    );

    const started = fireEvent.dragStart(row('a1'), {
      dataTransfer: transfer(),
    });

    expect(started).toBe(false);
  });
});
