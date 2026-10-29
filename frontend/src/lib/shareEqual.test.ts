/**
 * Structural sharing keeps every equal part of a polled answer as the object
 * held before, so only what changed gets a new identity.
 */

import { describe, expect, it } from 'vitest';
import { shareEqual } from './shareEqual';

describe('shareEqual', () => {
  it('hands back the earlier value when the new one is equal throughout', () => {
    const prev = { teams: [{ id: 'a', name: 'A', tags: ['x'] }] };
    const next = { teams: [{ id: 'a', name: 'A', tags: ['x'] }] };

    expect(shareEqual(prev, next)).toBe(prev);
  });

  it('keeps unchanged entries and swaps in only the changed one', () => {
    const prev = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ];
    const next = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B2' },
    ];

    const shared = shareEqual(prev, next);

    expect(shared).not.toBe(prev);
    expect(shared[0]).toBe(prev[0]);
    expect(shared[1]).not.toBe(prev[1]);
    expect(shared[1]).toEqual(next[1]);
  });

  it('matches entries by id when they move', () => {
    const a = { id: 'a', title: 'A' };
    const b = { id: 'b', title: 'B' };

    const shared = shareEqual([a, b], [{ ...b }, { ...a }]);

    expect(shared[0]).toBe(b);
    expect(shared[1]).toBe(a);
  });

  it('treats a dropped or added field as a change', () => {
    const prev: Record<string, unknown> = { id: 'a', note: undefined };
    const next: Record<string, unknown> = { id: 'a' };

    expect(shareEqual(prev, next)).not.toBe(prev);
    expect(shareEqual(prev, next)).toEqual(next);
    expect(shareEqual(next, prev)).not.toBe(next);
  });

  it('compares anything but arrays and plain objects by identity', () => {
    const prev = new Set(['a']);
    const next = new Set(['a']);

    expect(shareEqual(prev, next)).toBe(next);
    expect(shareEqual(null, next)).toBe(next);
  });
});
