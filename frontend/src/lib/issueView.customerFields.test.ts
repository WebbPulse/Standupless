/**
 * The customer status, tier, revenue, size, request count and important
 * request filters: offered only where customers may be read, written to and
 * read back from the URL, sent as the list's query keys, kept through a saved
 * view and its groups, and left to the server when a list filters locally.
 */

import { describe, expect, it } from 'vitest';
import type { OrderedIssueRead } from '../api/issues';
import type { SavedViewDisplayRead } from '../api/views';
import {
  defaultViewState,
  filterFieldsFor,
  isFilterNumber,
  matchesFilters,
  parseViewState,
  sameViewState,
  stateToViewBody,
  viewStateQuery,
  viewToState,
  writeViewState,
  type FilterClause,
  type IssueContext,
  type ViewState,
} from './issueView';

const base = defaultViewState('list');

const context: IssueContext = {
  statuses: [],
  labels: [],
  people: [],
  projects: [],
  cycles: [],
};

const filtered: FilterClause[] = [
  { field: 'customer_status', op: 'is', values: ['active', 'none'] },
  { field: 'customer_tier', op: 'is_not', values: ['tier-enterprise'] },
  { field: 'customer_revenue', op: 'at_least', values: ['50000'] },
  { field: 'customer_revenue', op: 'at_most', values: ['900000'] },
  { field: 'customer_size', op: 'at_most', values: ['200'] },
  { field: 'customer_requests', op: 'at_least', values: ['2'] },
  { field: 'customer_important', op: 'is', values: ['true'] },
];

const state: ViewState = { ...base, filters: filtered };

const issue = (): OrderedIssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'st-todo',
  priority: 'medium',
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
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});

describe('the customer field filters', () => {
  it('are offered only where the reader may see customers', () => {
    const fields = [
      'customer_status',
      'customer_tier',
      'customer_revenue',
      'customer_size',
      'customer_requests',
      'customer_important',
    ];
    const guest = filterFieldsFor(context);
    const member = filterFieldsFor({ ...context, customers: [] });
    for (const field of fields) {
      expect(guest).not.toContain(field);
      expect(member).toContain(field);
    }
  });

  it('round trip through the URL', () => {
    const params = writeViewState(state, base);
    expect(params.getAll('f')).toEqual([
      'customer_status.is:active,none',
      'customer_tier.not:tier-enterprise',
      'customer_revenue.min:50000',
      'customer_revenue.max:900000',
      'customer_size.max:200',
      'customer_requests.min:2',
      'customer_important.is:true',
    ]);
    expect(sameViewState(parseViewState(params, base), state)).toBe(true);
  });

  it('drops a malformed number bound from the URL', () => {
    const read = parseViewState(
      new URLSearchParams([
        ['f', 'customer_revenue.min:lots'],
        ['f', 'customer_size.max:-3'],
        ['f', 'customer_requests.min:12345678901234567'],
        ['f', 'customer_important.not:true'],
      ]),
      base
    );
    expect(read.filters).toEqual([
      { field: 'customer_important', op: 'is', values: ['true'] },
    ]);
  });

  it('send the list query keys', () => {
    expect(viewStateQuery(state)).toMatchObject({
      customer_status_id: ['active', 'none'],
      customer_tier_id_not: ['tier-enterprise'],
      customer_revenue_min: '50000',
      customer_revenue_max: '900000',
      customer_size_max: '200',
      customer_request_count_min: '2',
      customer_important: 'true',
    });
  });

  it('write No requests as an upper bound of 0', () => {
    const none: ViewState = {
      ...base,
      filters: [{ field: 'customer_requests', op: 'at_most', values: ['0'] }],
    };
    expect(viewStateQuery(none)).toMatchObject({
      customer_request_count_max: '0',
    });
  });

  it('save with a view and read back, groups included', () => {
    const grouped: ViewState = {
      ...state,
      groups: [
        {
          match: 'any',
          filters: [
            { field: 'customer_tier', op: 'is', values: ['tier-growth'] },
            { field: 'customer_size', op: 'at_least', values: ['10'] },
          ],
        },
      ],
    };
    const body = stateToViewBody(grouped, 'Big customers');
    expect(body.filter).toMatchObject({
      customer_revenue_min: '50000',
      customer_important: 'true',
      groups: [
        {
          match: 'any',
          customer_tier_id: ['tier-growth'],
          customer_size_min: '10',
        },
      ],
    });
    const view = {
      view_id: 'v-1',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead;
    expect(sameViewState(viewToState(view), grouped)).toBe(true);
  });

  it('read a stored number written as a JSON number', () => {
    const view = {
      view_id: 'v-1',
      ...stateToViewBody(base, 'Agent view'),
      filter: { customer_request_count_min: 3 },
      team_id: null,
    } as unknown as SavedViewDisplayRead;
    expect(viewToState(view).filters).toEqual([
      { field: 'customer_requests', op: 'at_least', values: ['3'] },
    ]);
  });

  it('are left to the server when a list filters locally', () => {
    expect(matchesFilters(issue(), filtered)).toBe(true);
  });

  it('take whole numbers up to the server limit', () => {
    expect(isFilterNumber('0')).toBe(true);
    expect(isFilterNumber('1000000000000000')).toBe(true);
    expect(isFilterNumber('1000000000000001')).toBe(false);
    expect(isFilterNumber('1.5')).toBe(false);
    expect(isFilterNumber('')).toBe(false);
  });
});
