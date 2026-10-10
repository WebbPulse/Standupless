/**
 * The home's pure shape: each attention issue sits under its most urgent
 * reason only, and section jumps land on the first row of the next or
 * previous section without running off either end.
 */

import { describe, expect, it } from 'vitest';
import type { HomeFocusRead, IssueRead } from '../../../types/Api';
import {
  focusGroups,
  greetingFor,
  jumpSection,
  type HomeNavItem,
} from './homeModel';

const issue = (id: string): IssueRead => ({ id }) as IssueRead;

const focus = (overrides: Partial<HomeFocusRead>): HomeFocusRead => ({
  open_count: 0,
  truncated: false,
  attention_count: 0,
  in_progress_count: 0,
  up_next_count: 0,
  attention: [],
  in_progress: [],
  up_next: [],
  ...overrides,
});

describe('focusGroups', () => {
  it('files each attention issue under its most urgent reason, then the rest', () => {
    const groups = focusGroups(
      focus({
        attention: [
          { issue: issue('a'), reasons: ['due_soon', 'sla_breached'] },
          { issue: issue('b'), reasons: ['blocked'] },
          { issue: issue('c'), reasons: ['overdue'] },
        ],
        in_progress: [issue('d')],
        in_progress_count: 4,
      })
    );

    expect(groups.map((group) => group.id)).toEqual([
      'overdue',
      'sla_breached',
      'blocked',
      'in_progress',
    ]);
    expect(groups[1]?.issues.map((row) => row.id)).toEqual(['a']);
    expect(groups[3]?.total).toBe(4);
  });

  it('is empty when nothing is assigned', () => {
    expect(focusGroups(focus({}))).toEqual([]);
  });
});

describe('jumpSection', () => {
  const items: HomeNavItem[] = [
    { section: 'focus', id: '1' },
    { section: 'focus', id: '2' },
    { section: 'cycles', id: '3' },
    { section: 'inbox', id: '4' },
    { section: 'inbox', id: '5' },
  ];

  it('moves to the first row of the next and previous section', () => {
    expect(jumpSection(items, 1, 1)).toBe(2);
    expect(jumpSection(items, 2, 1)).toBe(3);
    expect(jumpSection(items, 4, -1)).toBe(2);
  });

  it('stays on the last section going forward and the first going back', () => {
    expect(jumpSection(items, 4, 1)).toBe(3);
    expect(jumpSection(items, 0, -1)).toBe(0);
  });

  it('starts at either end from nothing highlighted', () => {
    expect(jumpSection(items, -1, 1)).toBe(0);
    expect(jumpSection(items, -1, -1)).toBe(3);
    expect(jumpSection([], -1, 1)).toBe(-1);
  });
});

describe('greetingFor', () => {
  it('follows the clock', () => {
    expect(greetingFor(8)).toBe('Good morning');
    expect(greetingFor(14)).toBe('Good afternoon');
    expect(greetingFor(21)).toBe('Good evening');
  });
});
