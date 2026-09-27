/**
 * The remembered set behind folded groups and hidden columns. Covers that a
 * toggle is kept across a remount, that each storage key holds its own set,
 * that unreadable storage reads as empty, and that no key keeps it in memory.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStoredSet } from './useStoredSet';

describe('useStoredSet', () => {
  it('remembers a toggled key across a remount', () => {
    const first = renderHook(() => useStoredSet('test.set'));
    act(() => {
      first.result.current[1]('todo');
    });
    expect(first.result.current[0].has('todo')).toBe(true);
    first.unmount();

    const second = renderHook(() => useStoredSet('test.set'));
    expect(second.result.current[0].has('todo')).toBe(true);

    act(() => {
      second.result.current[1]('todo');
    });
    expect(second.result.current[0].size).toBe(0);
    expect(globalThis.localStorage.getItem('test.set')).toBeNull();
  });

  it('reads the set of a new key in place of the last one', () => {
    globalThis.localStorage.setItem('test.a', JSON.stringify(['one']));
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useStoredSet(key),
      { initialProps: { key: 'test.a' } }
    );
    expect([...result.current[0]]).toEqual(['one']);

    rerender({ key: 'test.b' });

    expect(result.current[0].size).toBe(0);
  });

  it('reads unreadable storage as empty', () => {
    globalThis.localStorage.setItem('test.bad', '{not json');
    const { result } = renderHook(() => useStoredSet('test.bad'));

    expect(result.current[0].size).toBe(0);
  });

  it('keeps the set in memory without a key', () => {
    const { result } = renderHook(() => useStoredSet(undefined));
    act(() => {
      result.current[1]('done');
    });

    expect(result.current[0].has('done')).toBe(true);
    expect(globalThis.localStorage.length).toBe(0);
  });
});
