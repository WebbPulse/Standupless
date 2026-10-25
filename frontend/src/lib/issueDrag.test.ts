/**
 * What an issue drag carries: the issue keys as plain text and the ids under
 * its own type, the issues held for a target outside the view until the drag
 * ends, and a check that tells it apart from a drag of a sidebar row.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../api/issues';
import {
  activeIssueDrag,
  carriesIssues,
  endIssueDrag,
  ISSUE_DRAG_TYPE,
  startIssueDrag,
  type IssueDragSource,
} from './issueDrag';

/** An issue with just the fields a drag reads. */
const issue = (id: string, key: string): OrderedIssueRead =>
  ({ id, key, team_id: 'team-1' }) as OrderedIssueRead;

/** A drag source holding `issues`, all of them editable. */
const source = (issues: OrderedIssueRead[]): IssueDragSource => ({
  issues,
  canEdit: () => true,
  update: vi.fn(),
  queryKey: ['issues', 'team-1'],
});

afterEach(() => {
  endIssueDrag();
});

describe('startIssueDrag', () => {
  it('writes the keys as text and the ids under the issue type', () => {
    const setData = vi.fn();
    const held = source([issue('a', 'ENG-1'), issue('b', 'ENG-2')]);

    startIssueDrag({ setData }, held);

    expect(setData).toHaveBeenCalledWith('text/plain', 'ENG-1\nENG-2');
    expect(setData).toHaveBeenCalledWith(
      ISSUE_DRAG_TYPE,
      JSON.stringify(['a', 'b'])
    );
    expect(activeIssueDrag()).toBe(held);
  });

  it('holds the issues even when the transfer cannot be written', () => {
    const held = source([issue('a', 'ENG-1')]);

    startIssueDrag(null, held);

    expect(activeIssueDrag()).toBe(held);
  });

  it('forgets the issues once the drag ends', () => {
    startIssueDrag(null, source([issue('a', 'ENG-1')]));

    endIssueDrag();

    expect(activeIssueDrag()).toBeNull();
  });
});

describe('carriesIssues', () => {
  it('is false while no issue drag is in progress', () => {
    expect(carriesIssues({ types: [ISSUE_DRAG_TYPE] })).toBe(false);
  });

  it('is true for a transfer naming the issue type', () => {
    startIssueDrag(null, source([issue('a', 'ENG-1')]));

    expect(carriesIssues({ types: ['text/plain', ISSUE_DRAG_TYPE] })).toBe(
      true
    );
  });

  it('is false for a sidebar row drag, which writes only text', () => {
    startIssueDrag(null, source([issue('a', 'ENG-1')]));

    expect(carriesIssues({ types: ['text/plain'] })).toBe(false);
  });
});
