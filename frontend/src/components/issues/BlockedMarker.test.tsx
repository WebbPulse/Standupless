/**
 * The blocked and blocking flags a list row draws. Covers that each shows only
 * while its count is above zero, that it names and prints the count for one
 * and many, that a resolved blocker drops out of the count, that older rows
 * without the count draw nothing, and that the tooltip names open blockers
 * only.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { IssueRead, LinkRead } from '../../types/Api';
import {
  BlockedMarker,
  BlockingMarker,
  RelationMarkers,
  relationLines,
} from './BlockedMarker';

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
        <li>
          <RelationMarkers issue={row} />
        </li>
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

  it('shows the blocking flag beside the blocked one', () => {
    renderRow(issue({ blocked_by_open_count: 1, blocking_count: 3 }));
    expect(
      screen.getByRole('img', { name: 'Blocking 3 issues' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Blocked by 1 open issue' })
    ).toBeInTheDocument();
  });

  it('draws no blocking flag once the issue blocks nothing', () => {
    const { container } = render(<BlockingMarker count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('relation counts', () => {
  const shown = (name: string): string | null =>
    screen.getByRole('img', { name }).querySelector('[data-relation-count]')
      ?.textContent ?? null;

  it('prints no count and no flag at zero', () => {
    const { container } = renderRow(
      issue({ blocked_by_open_count: 0, blocking_count: 0 })
    );
    expect(container.querySelector('[data-relation-count]')).toBeNull();
  });

  it('prints a count of one beside each flag', () => {
    renderRow(issue({ blocked_by_open_count: 1, blocking_count: 1 }));
    expect(shown('Blocked by 1 open issue')).toBe('1');
    expect(shown('Blocking 1 issue')).toBe('1');
  });

  it('prints many beside each flag', () => {
    renderRow(issue({ blocked_by_open_count: 4, blocking_count: 12 }));
    expect(shown('Blocked by 4 open issues')).toBe('4');
    expect(shown('Blocking 12 issues')).toBe('12');
  });

  it('drops a resolved blocker out of the count', () => {
    const { rerender } = renderRow(issue({ blocked_by_open_count: 2 }));
    expect(shown('Blocked by 2 open issues')).toBe('2');
    rerender(
      <MemoryRouter>
        <ul>
          <li>
            <RelationMarkers issue={issue({ blocked_by_open_count: 1 })} />
          </li>
        </ul>
      </MemoryRouter>
    );
    expect(shown('Blocked by 1 open issue')).toBe('1');
    expect(
      screen.queryByRole('img', { name: 'Blocked by 2 open issues' })
    ).toBeNull();
  });
});

const link = (
  type: LinkRead['type'],
  key: string,
  title: string,
  category?: 'completed' | 'cancelled' | 'started'
): LinkRead => ({
  link_id: `ln-${key}`,
  issue_id: 'iss-1',
  type,
  target_issue_id: `id-${key}`,
  target_key: key,
  target_title: title,
  target_status:
    category === undefined ? null : { id: 'st', name: 'S', category },
  created_by: 'user-1',
  created_at: '2026-10-15T00:00:00Z',
});

describe('relationLines', () => {
  it('names open blockers by key and title, skipping finished ones', () => {
    const links = [
      link('blocked_by', 'ENG-2', 'Open blocker', 'started'),
      link('blocked_by', 'ENG-3', 'Done blocker', 'completed'),
      link('blocked_by', 'ENG-4', 'Dropped blocker', 'cancelled'),
      link('blocks', 'ENG-5', 'Downstream'),
    ];
    expect(relationLines(links, 'blocked_by')).toEqual(['ENG-2  Open blocker']);
    expect(relationLines(links, 'blocks')).toEqual(['ENG-5  Downstream']);
  });

  it('cuts long titles and counts what does not fit', () => {
    const long = 'x'.repeat(80);
    const links = Array.from({ length: 10 }, (_, index) =>
      link('blocks', `ENG-${String(index)}`, long)
    );
    const lines = relationLines(links, 'blocks');
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe(`ENG-0  ${'x'.repeat(59)}…`);
    expect(lines[8]).toBe('and 2 more');
  });
});
