/**
 * Optimistic writes over a polled record. Covers that a patch shows at once,
 * that a failure takes back only its own patch and raises a notice, that a
 * confirmed write is held until the poll catches up, and that a stale poll
 * cannot overwrite it.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOptimisticRecord } from './optimistic';
import { clearToasts, currentToasts } from './toast';

interface Row {
  id: string;
  name: string;
  size: number;
  updated_at: string;
}

const row: Row = { id: 'r1', name: 'first', size: 1, updated_at: '2026-09-01' };

afterEach(() => {
  clearToasts();
});

/** A promise and the handles that settle it from the test. */
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('useOptimisticRecord', () => {
  it('applies a patch at once and keeps the saved record', async () => {
    const pending = deferred<Row>();
    const write = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useOptimisticRecord<Row, Partial<Row>>(row, { write })
    );
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = result.current.update({ name: 'second' });
    });
    expect(result.current.value?.name).toBe('second');
    expect(result.current.isSaving).toBe(true);
    await act(async () => {
      pending.resolve({ ...row, name: 'second', updated_at: '2026-09-02' });
      await done;
    });
    expect(await done).toBe(true);
    expect(result.current.value?.name).toBe('second');
    expect(result.current.isSaving).toBe(false);
  });

  it('rolls back only the failed patch and raises a notice', async () => {
    const first = deferred<Row>();
    const second = deferred<Row>();
    const write = vi
      .fn<(patch: Partial<Row>) => Promise<Row>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useOptimisticRecord<Row, Partial<Row>>(row, { write })
    );
    let failed: Promise<boolean> = Promise.resolve(true);
    act(() => {
      failed = result.current.update({ name: 'lost' });
      void result.current.update({ size: 5 });
    });
    expect(result.current.value).toMatchObject({ name: 'lost', size: 5 });
    await act(async () => {
      first.reject(new Error('boom'));
      await failed;
    });
    expect(await failed).toBe(false);
    expect(result.current.value).toMatchObject({ name: 'first', size: 5 });
    expect(currentToasts().map((toast) => toast.tone)).toContain('error');
  });

  it('keeps a confirmed write until a newer read arrives', async () => {
    const write = vi.fn(() =>
      Promise.resolve({ ...row, name: 'saved', updated_at: '2026-09-02' })
    );
    const { result, rerender } = renderHook(
      ({ server }: { server: Row }) =>
        useOptimisticRecord<Row, Partial<Row>>(server, { write }),
      { initialProps: { server: row } }
    );
    await act(async () => {
      await result.current.update({ name: 'saved' });
    });
    rerender({ server: { ...row } });
    expect(result.current.value?.name).toBe('saved');
    rerender({
      server: { ...row, name: 'elsewhere', updated_at: '2026-09-03' },
    });
    expect(result.current.value?.name).toBe('elsewhere');
  });

  it('shows the server copy of a different record', () => {
    const write = vi.fn(() => Promise.resolve(row));
    const { result, rerender } = renderHook(
      ({ server }: { server: Row | null }) =>
        useOptimisticRecord<Row, Partial<Row>>(server, { write }),
      { initialProps: { server: null as Row | null } }
    );
    expect(result.current.value).toBeNull();
    act(() => {
      result.current.receive(row);
    });
    rerender({ server: { ...row, id: 'r2', name: 'other' } });
    expect(result.current.value?.name).toBe('other');
  });
});
