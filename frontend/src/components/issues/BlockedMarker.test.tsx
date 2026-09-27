/**
 * The blocked mark on a list row. Covers that it shows only while an open
 * blocker remains, that it names the count, and that older rows without the
 * count draw nothing.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { IssueRead } from '../../types/Api';
import { BlockedMarker } from './BlockedMarker';
import IssueRow from './IssueRow';

const issue = (overrides: Partial<IssueRead>): IssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Issue 1',
  body: null,
  status_id: 'st-1',
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

const renderRow = (row: IssueRead) =>
  render(
    <MemoryRouter>
      <ul>
        <IssueRow
          issue={row}
          slug="acme"
          statuses={[]}
          labels={[]}
          people={[]}
        />
      </ul>
    </MemoryRouter>
  );

describe('BlockedMarker', () => {
  it('shows on a row an open issue still blocks', () => {
    renderRow(issue({ blocked_by_open_count: 2 }));
    expect(
      screen.getByRole('img', { name: 'Blocked by 2 open issues' })
    ).toBeInTheDocument();
  });

  it('draws nothing once no open blocker remains', () => {
    renderRow(issue({ blocked_by_open_count: 0 }));
    expect(screen.queryByRole('img', { name: /Blocked/ })).toBeNull();
  });

  it('draws nothing for a row that predates the count', () => {
    const { container } = render(<BlockedMarker count={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads one blocker in the singular', () => {
    render(<BlockedMarker count={1} />);
    expect(
      screen.getByRole('img', { name: 'Blocked by 1 open issue' })
    ).toBeInTheDocument();
  });
});
