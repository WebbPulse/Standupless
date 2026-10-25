/**
 * The board columns each team issue preset shows: Active and Backlog show
 * only the status categories they cover, even with empty columns on, and
 * every issue keeps its full column set and its hide-empty option.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../../hooks/useShortcuts';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import { defaultViewState, type IssueContext } from '../../../lib/issueView';
import {
  teamScopeCategories,
  type TeamIssueScope,
} from '../../../lib/teamIssueScope';
import type { StatusCategory } from '../../../types/Api';
import IssueListView from './IssueListView';

/** One issue in a status. */
const make = (id: string, statusId: string): OrderedIssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: `Issue ${id}`,
  body: null,
  status_id: statusId,
  priority: 'none',
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

/** A team status. */
const status = (
  id: string,
  name: string,
  category: StatusCategory,
  position: number
) => ({ id, name, category, position, team_id: 'team-1' });

const context: IssueContext = {
  statuses: [
    status('st-backlog', 'Backlog', 'backlog', 0),
    status('st-todo', 'Todo', 'unstarted', 1),
    status('st-doing', 'Doing', 'started', 2),
    status('st-done', 'Done', 'completed', 3),
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

/** Mounts the board for a preset over some issues, with empty columns on or off. */
const renderBoard = (
  scope: TeamIssueScope,
  issues: OrderedIssueRead[],
  showEmpty = true
) => {
  render(
    <MemoryRouter>
      <ShortcutRegistryContext.Provider value={createShortcutRegistry()}>
        <IssueListView
          slug="mine"
          state={{ ...defaultViewState('board'), showEmpty }}
          onStateChange={vi.fn()}
          collection={{
            issues,
            isLoading: false,
            error: null,
            truncated: false,
            queryKey: ['issues'],
            update: vi.fn(),
          }}
          lists={lists}
          scaleFor={() => 'off'}
          canEdit
          statusCategories={teamScopeCategories(scope)}
        />
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

/** The trailing words of a column's options button name. */
const OPTIONS = / column options$/;

/** The column names the board shows, in order. */
const columns = (): string[] =>
  screen
    .getAllByRole('button', { name: OPTIONS })
    .map((button) => button.getAttribute('aria-label') ?? '')
    .map((label) => label.replace(OPTIONS, ''));

describe('board columns per team issue preset', () => {
  it('shows every status on All issues', () => {
    renderBoard('all', [make('a', 'st-todo')]);

    expect(columns()).toEqual(['Backlog', 'Todo', 'Doing', 'Done']);
  });

  it('keeps the hide-empty option on All issues', () => {
    renderBoard('all', [make('a', 'st-todo'), make('b', 'st-doing')], false);

    expect(columns()).toEqual(['Todo', 'Doing']);
  });

  it('shows only unstarted and started columns on Active', () => {
    renderBoard('active', [make('a', 'st-todo')]);

    expect(columns()).toEqual(['Todo', 'Doing']);
  });

  it('shows only backlog columns on Backlog', () => {
    renderBoard('backlog', [make('a', 'st-backlog')]);

    expect(columns()).toEqual(['Backlog']);
  });
});
