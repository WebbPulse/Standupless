/**
 * The drop rules the board and the list share: which groupings take a drop
 * from another group, and who may drag an issue.
 */

import { describe, expect, it } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import { canDragIssue, takesDrop } from './issueDrop';

describe('takesDrop', () => {
  it('takes a drop into a grouping a drag can set', () => {
    expect(takesDrop('status', {})).toBe(true);
    expect(takesDrop('priority', {})).toBe(true);
  });

  it('refuses groupings that only show where an issue sits', () => {
    expect(takesDrop('team', {})).toBe(false);
    expect(takesDrop('parent', {})).toBe(false);
    expect(takesDrop('sla', {})).toBe(false);
  });

  it('takes a customer drop only where requests can be filed', () => {
    expect(takesDrop('customer', {})).toBe(false);
    expect(takesDrop('customer', { moveCustomer: () => undefined })).toBe(true);
  });
});

describe('canDragIssue', () => {
  const issue = { id: 'a1', team_id: 'team-1' } as OrderedIssueRead;

  it('follows the view when no issue rule is set', () => {
    expect(canDragIssue({ canEdit: true }, issue)).toBe(true);
    expect(canDragIssue({ canEdit: false }, issue)).toBe(false);
  });

  it('asks the issue rule when one is set', () => {
    expect(
      canDragIssue({ canEdit: true, canEditIssue: () => false }, issue)
    ).toBe(false);
  });
});
