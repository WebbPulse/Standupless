/**
 * The status position shortcuts: positions follow the picker's category then
 * position order, each team in a selection uses its own workflow, issues
 * already there are left out, and a team with too few statuses changes
 * nothing and raises a notice.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isStatusPositionKeys,
  setStatusByPosition,
  statusAtPosition,
  statusPositionKeys,
  statusPositionLabel,
  type StatusPositionIssue,
  type StatusPositionWrite,
} from './statusPosition';
import { clearToasts, currentToasts } from './toast';
import type { StatusRead } from '../types/Api';

/** A status, in the order the server might send it. */
const status = (
  id: string,
  name: string,
  category: StatusRead['category'],
  position = 0
): StatusRead => ({ id, name, category, position });

const TEAM_ONE = [
  status('t1-done', 'Done', 'completed'),
  status('t1-review', 'In Review', 'started', 1),
  status('t1-progress', 'In Progress', 'started', 0),
  status('t1-todo', 'Todo', 'unstarted'),
  status('t1-backlog', 'Backlog', 'backlog'),
];

const TEAM_TWO = [
  status('t2-todo', 'Todo', 'unstarted'),
  status('t2-done', 'Done', 'completed'),
];

/** Each team's workflow. */
const statusesFor = (teamId: string): StatusRead[] =>
  teamId === 'team-1' ? TEAM_ONE : TEAM_TWO;

/** An issue of team-1 in Todo, overridden. */
const issue = (
  id: string,
  overrides: Partial<StatusPositionIssue> = {}
): StatusPositionIssue => ({
  id,
  team_id: 'team-1',
  status_id: 't1-todo',
  ...overrides,
});

afterEach(() => {
  clearToasts();
});

describe('status position keys', () => {
  it('binds Cmd or Ctrl+Alt and a digit', () => {
    expect(statusPositionKeys(3)).toBe('mod+alt+3');
    expect(isStatusPositionKeys('mod+alt+9')).toBe(true);
    expect(isStatusPositionKeys('mod+alt+0')).toBe(false);
    expect(isStatusPositionKeys('ctrl+shift+1')).toBe(false);
  });

  it('counts positions in category order, then by position', () => {
    expect(
      [1, 2, 3, 4, 5].map((at) => statusAtPosition(TEAM_ONE, at)?.id)
    ).toEqual(['t1-backlog', 't1-todo', 't1-progress', 't1-review', 't1-done']);
    expect(statusAtPosition(TEAM_ONE, 6)).toBeUndefined();
    expect(statusAtPosition(TEAM_ONE, 0)).toBeUndefined();
  });
});

describe('setStatusByPosition', () => {
  it('sets the status at the position, leaving out issues already there', () => {
    const write = vi.fn<StatusPositionWrite>();

    setStatusByPosition(
      [issue('a'), issue('b', { status_id: 't1-progress' })],
      3,
      statusesFor,
      write
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(['a'], { status_id: 't1-progress' });
  });

  it("uses each team's own workflow, one write per team", () => {
    const write = vi.fn<StatusPositionWrite>();

    setStatusByPosition(
      [issue('a'), issue('b', { team_id: 'team-2', status_id: 't2-todo' })],
      2,
      statusesFor,
      write
    );

    expect(write).toHaveBeenCalledWith(['a'], { status_id: 't1-todo' });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(['b'], { status_id: 't2-done' });
  });

  it('accepts an issue waiting in triage into the status it already holds', () => {
    const write = vi.fn<StatusPositionWrite>();

    setStatusByPosition(
      [issue('a', { in_triage: true })],
      2,
      statusesFor,
      write
    );

    expect(write).toHaveBeenCalledWith(['a'], { status_id: 't1-todo' });
  });

  it('skips a team with too few statuses and says how many were skipped', () => {
    const write = vi.fn<StatusPositionWrite>();

    setStatusByPosition(
      [issue('a'), issue('b', { team_id: 'team-2' })],
      4,
      statusesFor,
      write
    );

    expect(write).toHaveBeenCalledWith(['a'], { status_id: 't1-review' });
    expect(currentToasts().map((toast) => toast.message)).toEqual([
      '1 of 2 issues skipped: their team has fewer than 4 statuses',
    ]);
  });

  it('changes nothing and says so when no team has the position', () => {
    const write = vi.fn<StatusPositionWrite>();

    setStatusByPosition([issue('a')], 9, statusesFor, write);

    expect(write).not.toHaveBeenCalled();
    expect(currentToasts().map((toast) => toast.message)).toEqual([
      'No status in position 9 of this workflow',
    ]);
  });
});

describe('statusPositionLabel', () => {
  it('names the status when every team has the same one there', () => {
    expect(statusPositionLabel([issue('a')], 3, statusesFor)).toBe(
      'Set status to In Progress'
    );
    expect(
      statusPositionLabel(
        [issue('a'), issue('b', { team_id: 'team-2' })],
        3,
        statusesFor
      )
    ).toBe('Set status 3');
    expect(statusPositionLabel([issue('a')], 7, statusesFor)).toBe(
      'Set status 7'
    );
  });
});
