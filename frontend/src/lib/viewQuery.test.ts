/**
 * How a saved view's stored filter becomes the list route's query, and which
 * parts of it the page has to own up to not applying.
 */

import { describe, expect, it } from 'vitest';
import type { SavedViewRead } from '../types/Api';
import { unsupportedParts, viewQuery } from './viewQuery';

/** A saved view with an empty filter, for each test to narrow. */
const view = (overrides: Partial<SavedViewRead> = {}): SavedViewRead => ({
  view_id: 'view-1',
  workspace_id: 'ws-1',
  name: 'Bugs',
  kind: 'list',
  scope: 'personal',
  team_id: null,
  filter: {},
  sort: 'updated_desc',
  group_by: null,
  owner_id: 'user-1',
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
  ...overrides,
});

describe('viewQuery', () => {
  it('carries single values and the sort straight across', () => {
    expect(
      viewQuery(
        view({ filter: { team_id: 't-1', assignee_id: 'u-1', q: 'crash' } })
      )
    ).toEqual({
      sort: 'updated_desc',
      team_id: 't-1',
      assignee_id: 'u-1',
      q: 'crash',
    });
  });

  it('keeps the first of several values, which narrows rather than widens', () => {
    expect(
      viewQuery(
        view({
          filter: { label_id: ['l-1', 'l-2'], priority: ['high', 'low'] },
        })
      )
    ).toMatchObject({ label_id: 'l-1', priority: 'high' });
  });

  it('drops an empty search term', () => {
    expect(viewQuery(view({ filter: { q: '  ' } }))).not.toHaveProperty('q');
  });
});

describe('unsupportedParts', () => {
  it('says nothing for a filter the list route applies exactly', () => {
    expect(unsupportedParts(view({ filter: { team_id: 't-1' } }))).toEqual([]);
  });

  it('names every part the list route cannot apply', () => {
    const parts = unsupportedParts(
      view({
        filter: {
          status_id: ['s-1', 's-2'],
          status_category: 'started',
          due_before: '2026-10-01',
        },
        group_by: 'status',
      })
    );

    expect(parts).toHaveLength(4);
  });
});
