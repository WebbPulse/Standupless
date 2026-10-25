/**
 * The quick actions: adding to the active cycle uses a held running cycle
 * before asking the server, writes once per team, leaves out issues already
 * in it and raises a notice when a team has none; removing the due date and
 * the labels writes only the issues that carry them, the labels in one
 * change; and none of the keys collides with the pickers in either layout.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  propertyKeysFor,
  ADD_TO_ACTIVE_CYCLE_KEYS,
  REMOVE_DUE_DATE_KEYS,
  REMOVE_LABELS_KEYS,
} from '../components/issues/view/propertyKeys';
import { clearToasts, currentToasts } from '../lib/toast';
import type { CycleRead } from '../types/Api';
import {
  addToActiveCycle,
  appliedLabelIds,
  NO_ACTIVE_CYCLE_MESSAGE,
  removeDueDate,
  removeLabels,
  type QuickActionIssue,
  type QuickActionWrite,
} from './useQuickActions';

/** An issue of team-1 with no cycle, due date or labels, overridden. */
const issue = (
  id: string,
  overrides: Partial<QuickActionIssue> = {}
): QuickActionIssue => ({
  id,
  team_id: 'team-1',
  cycle_id: null,
  due_date: null,
  label_ids: [],
  ...overrides,
});

/** A running cycle of the team, overridden. */
const cycle = (
  id: string,
  teamId: string,
  overrides: Partial<CycleRead> = {}
): CycleRead =>
  ({
    cycle_id: id,
    workspace_id: 'ws-1',
    team_id: teamId,
    name: id,
    start_date: '2026-10-19',
    end_date: '2026-11-01',
    goal: null,
    cancelled: false,
    status: 'active',
    ...overrides,
  }) as CycleRead;

afterEach(() => {
  clearToasts();
});

describe('addToActiveCycle', () => {
  it('uses the held running cycle without asking the server', async () => {
    const write = vi.fn<QuickActionWrite>();
    const find = vi.fn(() => Promise.resolve(null));

    await addToActiveCycle(
      'ws-1',
      [issue('a'), issue('b')],
      write,
      () => [
        cycle('done', 'team-1', { status: 'completed' }),
        cycle('now', 'team-1'),
      ],
      find
    );

    expect(write).toHaveBeenCalledWith(['a', 'b'], { cycle_id: 'now' });
    expect(find).not.toHaveBeenCalled();
  });

  it('asks the server when no held cycle is running, once per team', async () => {
    const write = vi.fn<QuickActionWrite>();
    const find = vi.fn((_: string, teamId: string) =>
      Promise.resolve(cycle(`${teamId}-now`, teamId))
    );

    await addToActiveCycle(
      'ws-1',
      [issue('a'), issue('b', { team_id: 'team-2' }), issue('c')],
      write,
      () => [],
      find
    );

    expect(find).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(['a', 'c'], { cycle_id: 'team-1-now' });
    expect(write).toHaveBeenCalledWith(['b'], { cycle_id: 'team-2-now' });
  });

  it('leaves out issues already in the cycle', async () => {
    const write = vi.fn<QuickActionWrite>();

    await addToActiveCycle(
      'ws-1',
      [issue('a', { cycle_id: 'now' }), issue('b')],
      write,
      () => [cycle('now', 'team-1')]
    );

    expect(write).toHaveBeenCalledWith(['b'], { cycle_id: 'now' });
  });

  it('changes nothing and says so when the team has no active cycle', async () => {
    const write = vi.fn<QuickActionWrite>();

    await addToActiveCycle(
      'ws-1',
      [issue('a')],
      write,
      () => [],
      () => Promise.resolve(null)
    );

    expect(write).not.toHaveBeenCalled();
    expect(currentToasts().map((toast) => toast.message)).toEqual([
      NO_ACTIVE_CYCLE_MESSAGE,
    ]);
  });

  it('counts the issues skipped when only some teams have a cycle', async () => {
    const write = vi.fn<QuickActionWrite>();

    await addToActiveCycle(
      'ws-1',
      [issue('a'), issue('b', { team_id: 'team-2' })],
      write,
      () => [],
      (_, teamId) =>
        Promise.resolve(teamId === 'team-1' ? cycle('now', teamId) : null)
    );

    expect(write).toHaveBeenCalledWith(['a'], { cycle_id: 'now' });
    expect(currentToasts()[0]?.message).toMatch(/1 of 2 issues skipped/);
  });

  it('raises an error notice when the cycle lookup fails', async () => {
    const write = vi.fn<QuickActionWrite>();

    await addToActiveCycle(
      'ws-1',
      [issue('a')],
      write,
      () => [],
      () => Promise.reject(new Error('down'))
    );

    expect(write).not.toHaveBeenCalled();
    expect(currentToasts()[0]?.tone).toBe('error');
  });
});

describe('removeDueDate', () => {
  it('clears the due date of only the issues that have one', () => {
    const write = vi.fn<QuickActionWrite>();

    removeDueDate([issue('a', { due_date: '2026-11-01' }), issue('b')], write);

    expect(write).toHaveBeenCalledWith(['a'], { due_date: null });
  });

  it('writes nothing when no issue has a due date', () => {
    const write = vi.fn<QuickActionWrite>();

    removeDueDate([issue('a')], write);

    expect(write).not.toHaveBeenCalled();
  });
});

describe('removeLabels', () => {
  it('removes every applied label in one change', () => {
    const write = vi.fn<QuickActionWrite>();

    removeLabels(
      [
        issue('a', { label_ids: ['l-1', 'l-2'] }),
        issue('b', { label_ids: ['l-2', 'l-3'] }),
        issue('c'),
      ],
      write
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(['a', 'b'], {
      remove_label_ids: ['l-1', 'l-2', 'l-3'],
    });
  });

  it('lists each applied label once', () => {
    expect(
      appliedLabelIds([
        issue('a', { label_ids: ['l-1'] }),
        issue('b', { label_ids: ['l-1'] }),
      ])
    ).toEqual(['l-1']);
  });
});

describe('quick action keys', () => {
  it('collide with no property key in a list or on the board', () => {
    const quick = [
      ADD_TO_ACTIVE_CYCLE_KEYS,
      REMOVE_DUE_DATE_KEYS,
      REMOVE_LABELS_KEYS,
    ];
    for (const layout of ['list', 'board'] as const) {
      const taken = Object.values(propertyKeysFor(layout));
      expect(quick.filter((keys) => taken.includes(keys))).toEqual([]);
    }
    expect(REMOVE_LABELS_KEYS).not.toBe('shift+l');
  });
});
