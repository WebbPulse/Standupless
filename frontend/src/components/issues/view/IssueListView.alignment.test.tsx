/**
 * That every issue row reserves the same leading slots at the same widths in
 * every group, so status icons line up even when one group holds a parent
 * with a sub-issue chevron and keys differ in length.
 */

import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
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
import IssueListView from './IssueListView';

/** An issue in the given status, optionally under a parent. */
const make = (
  id: string,
  number: number,
  status: string,
  parent: string | null = null,
  children = 0
): OrderedIssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${String(number)}`,
  number,
  title: `Issue ${String(number)}`,
  body: null,
  status_id: status,
  priority: 'medium',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: parent,
  cycle_id: null,
  project_id: null,
  progress: { total: children, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
});

const issues: OrderedIssueRead[] = [
  make('iss-1', 1249, 'st-todo'),
  make('iss-2', 7, 'st-todo'),
  make('iss-3', 5, 'st-done', null, 1),
  make('iss-4', 1300, 'st-done', 'iss-3'),
  make('iss-5', 144, 'st-done'),
];

const context: IssueContext = {
  statuses: [
    {
      id: 'st-todo',
      name: 'Todo',
      category: 'unstarted',
      position: 0,
      team_id: 'team-1',
    },
    {
      id: 'st-done',
      name: 'Done',
      category: 'completed',
      position: 1,
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

/** Mounts the list grouped by status. */
const renderView = (state: Partial<ViewState> = {}): void => {
  const collection: IssueCollection = {
    issues,
    isLoading: false,
    error: null,
    truncated: false,
    queryKey: ['issues'],
    update: () => undefined,
  };
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={createShortcutRegistry()}>
        <IssueListView
          slug="mine"
          state={{ ...defaultViewState('list'), groupBy: 'status', ...state }}
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

/** The layout of a row's leading slots, everything ahead of the title. */
const leadingLayout = (row: Element): string[] => {
  const cells: string[] = [];
  for (const child of Array.from(row.children)) {
    if (child.tagName === 'A') break;
    const slot = child.getAttribute('data-slot');
    const style = child.getAttribute('style') ?? '';
    cells.push(slot === null ? child.tagName : `${slot}|${style}`);
  }
  const disclosure = row.querySelector('[data-slot="disclosure"]');
  cells.push(
    `disclosure:${disclosure?.className ?? 'missing'}|${disclosure?.getAttribute('style') ?? ''}`
  );
  return cells;
};

/** Every rendered issue row. */
const rows = (): Element[] =>
  Array.from(document.querySelectorAll('li[data-row-id]'));

describe('IssueListView column alignment', () => {
  it.each([true, false])(
    'gives every row in every group the same leading slots (sub-issues %s)',
    (showSubIssues) => {
      renderView({ showSubIssues });

      const all = rows();
      expect(all.length).toBeGreaterThanOrEqual(4);
      const first = leadingLayout(all[0] as Element);
      expect(first.some((cell) => cell.startsWith('key|'))).toBe(true);
      for (const row of all) {
        expect(leadingLayout(row)).toEqual(first);
      }
    }
  );

  it('sizes the key column for the longest key across all groups', () => {
    renderView();

    const root = document.querySelector('li[data-row-id]')?.closest('section')
      ?.parentElement as HTMLElement;
    expect(root.style.getPropertyValue('--issue-key-ch')).toBe('8');
  });

  it('indents a sub-issue by its title, not its leading slots', () => {
    renderView();

    const child = document.querySelector('li[data-row-id="iss-4"]');
    const parent = document.querySelector('li[data-row-id="iss-3"]');
    expect(child?.querySelector('a')?.style.paddingLeft).toBe('22px');
    expect(parent?.querySelector('a')?.style.paddingLeft).toBe('');
    expect(
      parent?.querySelector('[data-slot="disclosure"] button')
    ).not.toBeNull();
    expect(child?.querySelector('[data-slot="disclosure"] button')).toBeNull();
  });
});
