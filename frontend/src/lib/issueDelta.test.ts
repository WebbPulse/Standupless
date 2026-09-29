/**
 * Folding a delta read into held rows: replacing, adding, dropping, ordering
 * and keeping a partial list at its ceiling.
 */

import { describe, expect, it } from 'vitest';
import type { OrderedIssueRead } from '../api/issues';
import { mergeIssueDelta } from './issueDelta';

/** An issue with the given id and update time over a plain default. */
const issue = (id: string, updatedAt: string): OrderedIssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: id,
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
  created_at: '2026-09-17T00:00:00Z',
  updated_at: updatedAt,
});

const held = [
  issue('b', '2026-09-17T02:00:00Z'),
  issue('a', '2026-09-17T01:00:00Z'),
];

describe('mergeIssueDelta', () => {
  it('replaces a changed row and moves it into order', () => {
    const merged = mergeIssueDelta(
      held,
      { issues: [issue('a', '2026-09-17T03:00:00Z')], removedIds: [] },
      'updated_desc'
    );
    expect(merged.map((row) => row.id)).toEqual(['a', 'b']);
    expect(merged[0]?.updated_at).toBe('2026-09-17T03:00:00Z');
  });

  it('adds a new row and drops a removed one', () => {
    const merged = mergeIssueDelta(
      held,
      { issues: [issue('c', '2026-09-17T04:00:00Z')], removedIds: ['b'] },
      'updated_desc'
    );
    expect(merged.map((row) => row.id)).toEqual(['c', 'a']);
  });

  it('keeps a removed id out even when the same delta changed it', () => {
    const merged = mergeIssueDelta(
      held,
      { issues: [issue('a', '2026-09-17T05:00:00Z')], removedIds: ['a'] },
      'updated_desc'
    );
    expect(merged.map((row) => row.id)).toEqual(['b']);
  });

  it('cuts a partial list back to its ceiling', () => {
    const merged = mergeIssueDelta(
      held,
      { issues: [issue('c', '2026-09-17T04:00:00Z')], removedIds: [] },
      'updated_desc',
      2
    );
    expect(merged.map((row) => row.id)).toEqual(['c', 'b']);
  });

  it('hands back the rows unchanged for an empty delta', () => {
    expect(
      mergeIssueDelta(held, { issues: [], removedIds: [] }, 'updated_desc')
    ).toEqual(held);
  });
});
