/**
 * The label pills and status on a list row whose lists span teams, as on the
 * workspace home page. A workspace label every team inherits is one id listed
 * once per team, and the row must draw it once, as the issue's own team names
 * it.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ScopedLabel, ScopedStatus } from '../../lib/issueView';
import type { IssueRead } from '../../types/Api';
import IssueRow from './IssueRow';

const TEAMS = ['team-1', 'team-2', 'team-3'];

const issue = (overrides: Partial<IssueRead>): IssueRead => ({
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

const renderRow = (row: IssueRead) =>
  render(
    <MemoryRouter>
      <ul>
        <IssueRow
          issue={row}
          slug="acme"
          statuses={statuses}
          labels={labels}
          people={[]}
        />
      </ul>
    </MemoryRouter>
  );

const pillNames = (): string[] =>
  within(screen.getByRole('listitem'))
    .queryAllByText(/^(bug|defect|feature|dogfood)$/)
    .map((node) => node.textContent ?? '');

describe('IssueRow labels across teams', () => {
  it('draws a workspace label inherited by three teams once', () => {
    renderRow(issue({ label_ids: ['lbl-feature'] }));
    expect(pillNames()).toEqual(['feature']);
  });

  it('draws each label id once next to a team label', () => {
    renderRow(issue({ label_ids: ['lbl-bug', 'lbl-dogfood'] }));
    expect(pillNames()).toEqual(['bug', 'dogfood']);
  });

  it('names a workspace label as the issue team overrides it', () => {
    renderRow(issue({ team_id: 'team-2', label_ids: ['lbl-bug'] }));
    expect(pillNames()).toEqual(['defect']);
  });
});
