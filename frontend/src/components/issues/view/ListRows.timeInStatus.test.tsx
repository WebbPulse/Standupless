/**
 * The Time in status property on a list row: hidden by default, and when shown
 * a compact duration since the issue entered its status, with the moment in a
 * tooltip.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import {
  defaultViewState,
  type IssueContext,
  type ScopedLabel,
  type ScopedStatus,
} from '../../../lib/issueView';
import { IssueViewEnvContext, type IssueViewEnv } from './IssueViewContext';
import { IssueListRow } from './ListRows';

const TEAMS = ['team-1', 'team-2', 'team-3'];

const issue = (overrides: Partial<OrderedIssueRead>): OrderedIssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Issue 1',
  body: null,
  status_id: 'st-todo',
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
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  ...overrides,
});

/** Workspace bug and feature labels inherited by three teams, team-2 renaming bug, and a team-1 dogfood label. */
const labels: ScopedLabel[] = [
  ...TEAMS.flatMap((teamId) => [
    {
      id: 'lbl-bug',
      name: teamId === 'team-2' ? 'defect' : 'bug',
      color: '#f00',
      scope: 'workspace' as const,
      ...(teamId === 'team-2' ? { inherited_name: 'bug' } : {}),
      team_id: teamId,
    },
    {
      id: 'lbl-feature',
      name: 'feature',
      color: '#0f0',
      scope: 'workspace' as const,
      team_id: teamId,
    },
  ]),
  {
    id: 'lbl-dogfood',
    name: 'dogfood',
    color: '#00f',
    scope: 'team',
    team_id: 'team-1',
  },
];

const statuses: ScopedStatus[] = TEAMS.map((teamId) => ({
  id: 'st-todo',
  name: teamId === 'team-3' ? 'Queued' : 'Todo',
  category: 'unstarted',
  position: 0,
  team_id: teamId,
}));

const context: IssueContext = {
  statuses,
  labels,
  people: [],
  projects: [],
  cycles: [],
};

/** A viewer's env over the merged lists, selecting nothing. */
const env: IssueViewEnv = {
  slug: 'acme',
  state: { ...defaultViewState(), visible: ['id', 'time_in_status'] },
  context,
  forTeam: () => context,
  scaleFor: () => 'off',
  canEdit: false,
  update: vi.fn(),
  createLabel: () => Promise.resolve(null),
  focusedId: null,
  selected: new Set(),
  selectable: false,
  peekedKey: null,
  focus: vi.fn(),
  toggleSelected: vi.fn(),
  peek: vi.fn(),
};

const renderRow = (row: OrderedIssueRead, shown: IssueViewEnv = env) =>
  render(
    <MemoryRouter>
      <IssueViewEnvContext.Provider value={shown}>
        <ul>
          <IssueListRow issue={row} />
        </ul>
      </IssueViewEnvContext.Provider>
    </MemoryRouter>
  );

describe('IssueListRow time in status', () => {
  it('shows a compact duration since the issue entered its status', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    renderRow(issue({ status_changed_at: '2026-09-20T12:00:00Z' }));
    const cell = within(screen.getByRole('listitem')).getByText('5w');
    expect(cell.getAttribute('title')).toMatch(/^In status since /);
    vi.useRealTimers();
  });

  it('is not drawn while the property is hidden', () => {
    renderRow(issue({ status_changed_at: '2026-09-20T12:00:00Z' }), {
      ...env,
      state: defaultViewState(),
    });
    expect(screen.queryByTitle(/^In status since /)).not.toBeInTheDocument();
  });
});
