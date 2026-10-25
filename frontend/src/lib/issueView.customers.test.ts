/**
 * Grouping by customer: an issue sits under every customer that asked for it
 * and under No customer when none did, groups read by revenue then name, the
 * grouping is offered only where customers can be read, it rides the URL, and
 * a drag between customer columns files and withdraws the right requests.
 */

import { describe, expect, it } from 'vitest';
import { NONE, type OrderedIssueRead } from '../api/issues';
import { customersByIssue } from '../hooks/useCustomerRequestMap';
import type { CustomerRequestRead } from '../types/Api';
import {
  customerMove,
  defaultViewState,
  fieldsFor,
  GROUP_FIELDS,
  groupFieldsFor,
  groupIssues,
  isMovableGroupField,
  moveChange,
  parseViewState,
  sameViewState,
  writeViewState,
  type IssueContext,
  type ViewState,
} from './issueView';

/** An issue with the given fields over a plain default. */
const issue = (fields: Partial<OrderedIssueRead> = {}): OrderedIssueRead => ({
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
  ...fields,
});

const context: IssueContext = {
  statuses: [],
  labels: [],
  people: [],
  projects: [],
  cycles: [],
  customers: [
    { id: 'cus-beta', name: 'Beta', revenue: 5000, requestCount: 1 },
    { id: 'cus-acme', name: 'Acme', revenue: 5000, requestCount: 3 },
    { id: 'cus-big', name: 'Zenith', revenue: 90000, requestCount: 2 },
    { id: 'cus-new', name: 'Newco', revenue: null, requestCount: 0 },
  ],
  customerRequests: new Map([
    ['iss-shared', ['cus-acme', 'cus-big']],
    ['iss-acme', ['cus-acme']],
    ['iss-gone', ['cus-left']],
  ]),
};

const keys = (groups: { key: string }[]): string[] =>
  groups.map((group) => group.key);

const ids = (rows: OrderedIssueRead[]): string[] => rows.map((row) => row.id);

describe('grouping by customer', () => {
  it('is offered only where customers can be read', () => {
    expect(GROUP_FIELDS).toContain('customer');
    expect(fieldsFor(GROUP_FIELDS, {})).not.toContain('customer');
    expect(fieldsFor(GROUP_FIELDS, context)).toContain('customer');
    expect(groupFieldsFor({ ...context, teams: [] })).toContain('customer');
    expect(isMovableGroupField('customer')).toBe(true);
  });

  it('places an issue under every customer that asked and the rest under none', () => {
    const groups = groupIssues(
      [
        issue({ id: 'iss-shared' }),
        issue({ id: 'iss-acme' }),
        issue({ id: 'iss-plain' }),
      ],
      'customer',
      context,
      false
    );

    expect(keys(groups)).toEqual(['cus-big', 'cus-acme', NONE]);
    expect(ids(groups[0]?.issues ?? [])).toEqual(['iss-shared']);
    expect(ids(groups[1]?.issues ?? [])).toEqual(['iss-shared', 'iss-acme']);
    expect(ids(groups[2]?.issues ?? [])).toEqual(['iss-plain']);
    expect(groups[2]?.label).toBe('No customer');
  });

  it('orders by revenue then name and carries the request count', () => {
    const groups = groupIssues([], 'customer', context, true);

    expect(keys(groups)).toEqual([
      'cus-big',
      'cus-acme',
      'cus-beta',
      'cus-new',
      NONE,
    ]);
    expect(groups.map((group) => group.requests)).toEqual([
      2,
      3,
      1,
      0,
      undefined,
    ]);
  });

  it('gives a customer it cannot name a group of its own', () => {
    const groups = groupIssues(
      [issue({ id: 'iss-gone' })],
      'customer',
      context,
      false
    );

    expect(groups.map((group) => [group.key, group.label])).toEqual([
      ['cus-left', 'Unknown customer'],
    ]);
  });

  it('puts every issue under No customer before the requests load', () => {
    const { customerRequests: _loading, ...loading } = context;
    const groups = groupIssues(
      [issue({ id: 'iss-shared' })],
      'customer',
      loading,
      false
    );

    expect(keys(groups)).toEqual([NONE]);
  });

  it('rides the URL as a grouping', () => {
    const base = defaultViewState('board');
    const state: ViewState = {
      ...base,
      groupBy: 'customer',
      subGroupBy: 'status',
    };
    const params = writeViewState(state, base);

    expect(params.get('group')).toBe('customer');
    expect(sameViewState(parseViewState(params, base), state)).toBe(true);
  });
});

describe('dragging between customer columns', () => {
  const shared = issue({ id: 'iss-shared' });
  const plain = issue({ id: 'iss-plain' });

  it('changes no issue field', () => {
    expect(moveChange(shared, 'customer', 'cus-acme', NONE, context)).toEqual(
      {}
    );
  });

  it('files a request for the target and withdraws the source', () => {
    expect(customerMove(plain, NONE, 'cus-beta', context)).toEqual({
      add: 'cus-beta',
    });
    expect(customerMove(shared, 'cus-acme', NONE, context)).toEqual({
      remove: 'cus-acme',
    });
    expect(customerMove(shared, 'cus-acme', 'cus-beta', context)).toEqual({
      add: 'cus-beta',
      remove: 'cus-acme',
    });
  });

  it('files nothing the issue already holds', () => {
    expect(customerMove(shared, 'cus-acme', 'cus-big', context)).toEqual({
      remove: 'cus-acme',
    });
    expect(customerMove(shared, 'cus-acme', 'cus-acme', context)).toEqual({});
  });
});

describe('the request map', () => {
  const request = (fields: Partial<CustomerRequestRead>): CustomerRequestRead =>
    ({
      request_id: 'req-1',
      customer_id: 'cus-acme',
      target_kind: 'issue',
      target_id: 'iss-1',
      ...fields,
    }) as CustomerRequestRead;

  it('lists each customer once per issue and skips projects', () => {
    const byIssue = customersByIssue([
      request({ request_id: 'req-1' }),
      request({ request_id: 'req-2' }),
      request({ request_id: 'req-3', customer_id: 'cus-beta' }),
      request({
        request_id: 'req-4',
        target_kind: 'project',
        target_id: 'prj-1',
      }),
    ]);

    expect([...byIssue.entries()]).toEqual([
      ['iss-1', ['cus-acme', 'cus-beta']],
    ]);
  });
});
