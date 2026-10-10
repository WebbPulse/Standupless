/**
 * Grouping an issue's links into rows: a stack is one row in position order,
 * led by its lowest entry still open, and an unstacked pull request is its own
 * row. Covers a three pull request stack, a stack with its bottom entry merged,
 * and an unstacked pull request beside one.
 */

import { describe, expect, it } from 'vitest';
import type { GithubIssueLinkRead } from '../types/Api';
import {
  ciStateStyle,
  groupPullRequests,
  reviewStateStyle,
} from './pullRequestStacks';

/** One link, stacked at `position` when given. */
const link = (
  number: number,
  position: number | null,
  state: GithubIssueLinkRead['pr_state'] = 'open'
): GithubIssueLinkRead => ({
  link_id: `PR_${String(number)}#iss-1`,
  issue_id: 'iss-1',
  issue_key: 'ENG-1',
  repository_full_name: 'WebbPulse/standupless',
  pr_number: number,
  pr_title: `Part ${String(number)}`,
  pr_url: `https://github.com/WebbPulse/standupless/pull/${String(number)}`,
  pr_state: state,
  author_login: 'someone',
  closes_issue: false,
  applied_status_id: null,
  linked_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  stack:
    position === null
      ? null
      : {
          stack_id: 'repo:10',
          position,
          size: 3,
          pr_state: 'open',
          review_state: 'pending',
          ci_state: 'success',
        },
});

describe('groupPullRequests', () => {
  it('folds a three pull request stack into one row in position order', () => {
    const rows = groupPullRequests([link(12, 3), link(10, 1), link(11, 2)]);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.kind).toBe('stack');
    if (row?.kind !== 'stack') return;
    expect(row.entries.map((entry) => entry.pr_number)).toEqual([10, 11, 12]);
    expect(row.lead.pr_number).toBe(10);
  });

  it('leads with the lowest open entry once the bottom one merged', () => {
    const rows = groupPullRequests([
      link(10, 1, 'merged'),
      link(11, 2),
      link(12, 3),
    ]);

    const [row] = rows;
    if (row?.kind !== 'stack') throw new Error('expected a stack');
    expect(row.lead.pr_number).toBe(11);
  });

  it('leads a fully merged stack with its top entry', () => {
    const [row] = groupPullRequests([
      link(10, 1, 'merged'),
      link(11, 2, 'merged'),
    ]);

    if (row?.kind !== 'stack') throw new Error('expected a stack');
    expect(row.lead.pr_number).toBe(11);
  });

  it('keeps an unstacked pull request as its own row', () => {
    const rows = groupPullRequests([link(7, null), link(10, 1), link(11, 2)]);

    expect(rows.map((row) => row.kind)).toEqual(['single', 'stack']);
  });
});

describe('status styles', () => {
  it('shows nothing for no review and no checks, and for unknown values', () => {
    expect(reviewStateStyle('none')).toBeNull();
    expect(reviewStateStyle(undefined)).toBeNull();
    expect(reviewStateStyle('mystery')).toBeNull();
    expect(ciStateStyle('none')).toBeNull();
  });

  it('labels each state', () => {
    expect(reviewStateStyle('changes_requested')?.label).toBe(
      'Changes requested'
    );
    expect(ciStateStyle('failure')?.label).toBe('Checks failed');
  });
});
