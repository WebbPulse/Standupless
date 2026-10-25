/**
 * The SLA, Customers and Customer revenue properties on a list row and a
 * board card: the SLA badge only while its property is on, the requesting
 * customers as up to three initials and a count, and their summed revenue
 * hidden at zero, both only for a reader who may see customers.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { ViewVisibleProperty } from '../../../api/views';
import { defaultViewState, type IssueContext } from '../../../lib/issueView';
import { MetaChips } from './IssueProperties';
import { IssueViewEnvContext, type IssueViewEnv } from './IssueViewContext';
import { IssueListRow } from './ListRows';

const issue = (
  overrides: Partial<OrderedIssueRead> = {}
): OrderedIssueRead => ({
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

const base: IssueContext = {
  statuses: [
    {
      id: 'st-todo',
      name: 'Todo',
      category: 'unstarted',
      position: 0,
      team_id: 'team-1',
    },
  ],
  labels: [],
  people: [],
  projects: [],
  cycles: [],
};

const withCustomers: IssueContext = {
  ...base,
  customers: [
    { id: 'c-acme', name: 'Acme Corp', revenue: 10000 },
    { id: 'c-globex', name: 'Globex', revenue: 2500 },
    { id: 'c-initech', name: 'Initech', revenue: null },
    { id: 'c-umbrella', name: 'Umbrella', revenue: 0 },
    { id: 'c-other', name: 'Other', revenue: 99999 },
  ],
  customerRequests: new Map([
    ['iss-1', ['c-acme', 'c-globex', 'c-initech', 'c-umbrella']],
    ['iss-2', ['c-initech']],
  ]),
};

/** A viewer's env showing the given properties over a context. */
const envFor = (
  visible: ViewVisibleProperty[],
  context: IssueContext = withCustomers
): IssueViewEnv => ({
  slug: 'acme',
  state: { ...defaultViewState(), visible },
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
});

const renderRow = (row: OrderedIssueRead, env: IssueViewEnv) =>
  render(
    <MemoryRouter>
      <IssueViewEnvContext.Provider value={env}>
        <ul>
          <IssueListRow issue={row} />
        </ul>
      </IssueViewEnvContext.Provider>
    </MemoryRouter>
  );

const renderCard = (row: OrderedIssueRead, env: IssueViewEnv) =>
  render(
    <MemoryRouter>
      <IssueViewEnvContext.Provider value={env}>
        <MetaChips issue={row} card />
      </IssueViewEnvContext.Provider>
    </MemoryRouter>
  );

const covered = issue({
  sla_status: 'on_track',
  sla_started_at: '2026-10-24T00:00:00Z',
  sla_breaches_at: '2099-01-01T00:00:00Z',
});

describe('the SLA property', () => {
  it('is on by default, so the badge still shows', () => {
    expect(defaultViewState().visible).toContain('sla');
    const { container } = renderRow(
      covered,
      envFor(defaultViewState().visible)
    );
    expect(container.querySelector('[data-sla-status]')).not.toBeNull();
  });

  it('hides the badge while the property is off', () => {
    const { container } = renderRow(covered, envFor(['id']));
    expect(container.querySelector('[data-sla-status]')).toBeNull();
  });
});

describe('the Customers property', () => {
  it('draws up to three customers, highest revenue first, then a count', () => {
    renderRow(issue(), envFor(['customers']));
    const chip = screen.getByTitle(/^Customers: /);
    expect(chip.getAttribute('title')).toBe(
      'Customers: Acme Corp, Globex, Initech, Umbrella'
    );
    expect(chip.textContent).toContain('AC');
    expect(chip.textContent).toContain('+1');
  });

  it('draws nothing for an issue no customer asked for', () => {
    renderRow(issue({ id: 'iss-3' }), envFor(['customers']));
    expect(screen.queryByTitle(/^Customers: /)).not.toBeInTheDocument();
  });

  it('draws nothing for a reader who may not see customers', () => {
    renderRow(issue(), envFor(['customers', 'customer_revenue'], base));
    expect(screen.queryByTitle(/^Customers: /)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^Customer revenue: /)).not.toBeInTheDocument();
  });

  it('draws nothing while the property is off', () => {
    renderRow(issue(), envFor(['id']));
    expect(screen.queryByTitle(/^Customers: /)).not.toBeInTheDocument();
  });

  it('filters by the first customer where the list offers it', () => {
    const filter = vi.fn();
    renderRow(issue(), {
      ...envFor(['customers']),
      filterFor: (field) => (field === 'customer' ? filter : undefined),
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Filter by customer: Acme Corp/ })
    );
    expect(filter).toHaveBeenCalledWith('c-acme');
  });
});

describe('the Customer revenue property', () => {
  it('sums the requesting customers into a compact amount', () => {
    renderRow(issue(), envFor(['customer_revenue']));
    expect(screen.getByTitle('Customer revenue: $12.5K').textContent).toBe(
      '$12.5K'
    );
  });

  it('is hidden when the sum is zero', () => {
    renderRow(issue({ id: 'iss-2' }), envFor(['customer_revenue']));
    expect(screen.queryByTitle(/^Customer revenue: /)).not.toBeInTheDocument();
  });

  it('shows on a board card too', () => {
    renderCard(issue(), envFor(['customers', 'customer_revenue']));
    expect(screen.getByTitle('Customer revenue: $12.5K')).toBeInTheDocument();
    expect(screen.getByTitle(/^Customers: /)).toBeInTheDocument();
  });
});
