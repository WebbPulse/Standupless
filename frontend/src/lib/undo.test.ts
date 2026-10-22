/**
 * The undo history: each change raises one notice with Undo, the newest is
 * what undo reaches, a workspace only reaches its own changes, and a failed
 * revert says so instead of rejecting.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from './toast';
import {
  canUndo,
  clearUndo,
  currentUndo,
  pushUndo,
  UNDO_LIMIT,
  UNDO_TOAST_MS,
  undoLast,
} from './undo';

afterEach(() => {
  clearUndo();
  clearToasts();
  vi.useRealTimers();
});

describe('undo history', () => {
  it('raises a notice with an Undo button that reverts that change', async () => {
    const revert = vi.fn(() => Promise.resolve());
    pushUndo('ws-1', 'Changed status of ENG-1', revert);

    const [toast] = currentToasts();
    expect(toast?.message).toBe('Changed status of ENG-1');
    expect(toast?.action?.label).toBe('Undo');
    const action = toast?.action;
    if (action === undefined || !('run' in action)) throw new Error('no run');
    action.run();

    await vi.waitFor(() => {
      expect(revert).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(currentToasts().map((item) => item.message)).toEqual([
        'Change undone',
      ]);
    });
    expect(canUndo('ws-1')).toBe(false);
  });

  it('undoes the most recent change first, one per call', async () => {
    const order: string[] = [];
    pushUndo('ws-1', 'first', () => {
      order.push('first');
      return Promise.resolve();
    });
    pushUndo('ws-1', 'second', () => {
      order.push('second');
      return Promise.resolve();
    });

    expect(currentToasts().map((item) => item.message)).toEqual(['second']);
    await expect(undoLast('ws-1')).resolves.toBe(true);
    await expect(undoLast('ws-1')).resolves.toBe(true);
    await expect(undoLast('ws-1')).resolves.toBe(false);
    expect(order).toEqual(['second', 'first']);
  });

  it('only reaches changes made in the same workspace', async () => {
    const other = vi.fn(() => Promise.resolve());
    pushUndo('ws-2', 'elsewhere', other);

    expect(canUndo('ws-1')).toBe(false);
    await expect(undoLast('ws-1')).resolves.toBe(false);
    expect(other).not.toHaveBeenCalled();
  });

  it('reports a failed revert in an error notice', async () => {
    pushUndo('ws-1', 'change', () => Promise.reject(new Error('gone')));

    await expect(undoLast('ws-1')).resolves.toBe(true);
    const [toast] = currentToasts();
    expect(toast?.tone).toBe('error');
  });

  it('keeps the notice for about five seconds', () => {
    vi.useFakeTimers();
    pushUndo('ws-1', 'change', () => Promise.resolve());
    vi.advanceTimersByTime(UNDO_TOAST_MS - 1);
    expect(currentToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(currentToasts()).toHaveLength(0);
    expect(canUndo('ws-1')).toBe(true);
  });

  it('holds at most the limit, dropping the oldest', () => {
    for (let at = 0; at <= UNDO_LIMIT; at += 1) {
      pushUndo('ws-1', `change ${String(at)}`, () => Promise.resolve());
    }
    const held = currentUndo();
    expect(held).toHaveLength(UNDO_LIMIT);
    expect(held[0]?.message).toBe('change 1');
  });
});
