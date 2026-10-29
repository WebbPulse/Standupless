/**
 * The offline signal: it follows the shared reachability signal, so a request
 * that fails once is probed away without disabling writes, trouble that
 * outlasts the grace period holds writes back, and with the grace period
 * turned off a failure reads offline at once.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureReachability,
  DEFAULT_OFFLINE_GRACE_MS,
  reportNetworkFailure,
  reportNetworkSuccess,
} from '@webbpulse/api-client/react';
import { useOffline, useWritable } from './useOffline';

vi.unmock('./useOffline');

const reachable = (): Promise<void> => Promise.resolve();
const unreachable = (): Promise<void> =>
  Promise.reject(new TypeError('Failed to fetch'));

describe('useOffline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      reportNetworkSuccess();
    });
    configureReachability();
    vi.useRealTimers();
  });

  it('is online by default and lets permitted writes through', () => {
    expect(renderHook(() => useOffline()).result.current).toBe(false);
    expect(renderHook(() => useWritable(true)).result.current).toBe(true);
    expect(renderHook(() => useWritable(false)).result.current).toBe(false);
  });

  it('stays online when a probe answers after one failed request', async () => {
    const { result } = renderHook(() => useWritable(true));
    act(() => {
      reportNetworkFailure(reachable);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_GRACE_MS * 2);
    });
    expect(result.current).toBe(true);
  });

  it('holds writes back once the server stays unreachable past the grace period', async () => {
    const { result } = renderHook(() => useWritable(true));
    act(() => {
      reportNetworkFailure(unreachable);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_GRACE_MS - 1);
    });
    expect(result.current).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toBe(false);
    act(() => {
      reportNetworkSuccess();
    });
    expect(result.current).toBe(true);
  });

  it('goes offline at once with the grace period and probes turned off', () => {
    configureReachability({ graceMs: 0, probe: false });
    const { result } = renderHook(() => useOffline());
    act(() => {
      reportNetworkFailure();
    });
    expect(result.current).toBe(true);
  });
});
