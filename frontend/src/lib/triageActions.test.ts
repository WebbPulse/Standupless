/**
 * The triage actions follow Linear's order, so 1 accepts, 2 declines and 3
 * marks as a duplicate, and an accept defaults to the team's first visible
 * unstarted status.
 */

import { describe, expect, it } from 'vitest';
import type { StatusRead } from '../types/Api';
import {
  TRIAGE_ACTION,
  TRIAGE_ACTIONS,
  defaultAcceptStatus,
} from './triageActions';

const status = (overrides: Partial<StatusRead>): StatusRead => ({
  id: 'st-1',
  name: 'Todo',
  category: 'unstarted',
  position: 1,
  ...overrides,
});

describe('TRIAGE_ACTIONS', () => {
  it('numbers accept, decline and duplicate in Linear order', () => {
    expect(TRIAGE_ACTIONS.map((action) => [action.id, action.keys])).toEqual([
      ['accept', '1'],
      ['decline', '2'],
      ['duplicate', '3'],
      ['snooze', 'h'],
    ]);
  });

  it('keeps each action under its own id', () => {
    for (const action of TRIAGE_ACTIONS) {
      expect(TRIAGE_ACTION[action.id]).toBe(action);
    }
  });
});

describe('defaultAcceptStatus', () => {
  it('picks the lowest-position visible unstarted status', () => {
    const statuses = [
      status({ id: 'started', category: 'started', position: 0 }),
      status({ id: 'later', name: 'Later', position: 3 }),
      status({ id: 'hidden', name: 'Hidden', position: 0, hidden: true }),
      status({ id: 'todo', name: 'Todo', position: 2 }),
    ];
    expect(defaultAcceptStatus(statuses)?.id).toBe('todo');
  });

  it('breaks a position tie by name', () => {
    const statuses = [
      status({ id: 'b', name: 'Backlog', position: 1 }),
      status({ id: 'a', name: 'Accepted', position: 1 }),
    ];
    expect(defaultAcceptStatus(statuses)?.id).toBe('a');
  });

  it('answers null when the team has no unstarted status', () => {
    expect(defaultAcceptStatus([status({ category: 'started' })])).toBeNull();
  });
});
