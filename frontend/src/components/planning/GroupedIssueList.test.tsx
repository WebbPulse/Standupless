/**
 * The cycle page's list narrows itself when a row chip is clicked: the rows
 * filter on the client, the filter shows as a chip above the groups, and Clear
 * brings every row back. The click never opens the issue.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { IssueRead, LabelRead, StatusRead } from '../../types/Api';
import GroupedIssueList from './GroupedIssueList';

const issue = (fields: Partial<IssueRead>): IssueRead => ({
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
  cycle_id: 'cy-1',
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  ...fields,
});

const statuses: StatusRead[] = [
  { id: 'st-todo', name: 'Todo', category: 'unstarted', position: 0 },
];

const labels: LabelRead[] = [{ id: 'lb-bug', name: 'bug', color: '#f00' }];

const CYCLE = '/w/acme/team/ENG/cycles/cy-1';

const Where = () => {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
};

const renderList = () =>
  render(
    <MemoryRouter initialEntries={[CYCLE]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Where />
              <GroupedIssueList
                issues={[
                  issue({ label_ids: ['lb-bug'], title: 'Fix the crash' }),
                  issue({
                    id: 'iss-2',
                    key: 'ENG-2',
                    title: 'Write the docs',
                    priority: 'high',
                    estimate: 'S',
                  }),
                ]}
                isLoading={false}
                error={null}
                slug="acme"
                statuses={statuses}
                labels={labels}
                people={[]}
                emptyMessage="No issues in this cycle yet."
              />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

describe('GroupedIssueList chips', () => {
  it('narrows to a label and clears back', () => {
    renderList();

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter by label: bug' })
    );

    expect(screen.getByText('Fix the crash')).toBeInTheDocument();
    expect(screen.queryByText('Write the docs')).not.toBeInTheDocument();
    expect(screen.getByTestId('where').textContent).toBe(CYCLE);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByText('Write the docs')).toBeInTheDocument();
  });

  it('narrows by priority and by estimate', () => {
    renderList();

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter by priority: High' })
    );

    expect(screen.queryByText('Fix the crash')).not.toBeInTheDocument();
    expect(screen.getByText('Write the docs')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter by estimate: S' })
    );

    expect(screen.getByText('Write the docs')).toBeInTheDocument();
    expect(screen.getByTestId('where').textContent).toBe(CYCLE);
  });
});
