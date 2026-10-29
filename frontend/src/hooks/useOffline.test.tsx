/**
 * The offline signal: it follows the connectivity monitor, so a request that
 * fails once is probed away without disabling writes, trouble that outlasts
 * the grace period holds writes back, and the browser's offline flag does so
 * at once.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reportNetworkFailure,
  reportNetworkSuccess,
} from '@webbpulse/api-client/react';
import { connectivity, OFFLINE_GRACE_MS } from '../lib/connectivity';
import { useOffline, useWritable } from './useOffline';

vi.unmock('./useOffline');

const probe = vi.hoisted(() => ({ reachable: false }));

vi.mock('../api/client', () => ({
  apiClient: {
    get: vi.fn(() => {
      if (!probe.reachable) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      reportNetworkSuccess();
      return Promise.resolve({ data: null });
    }),
  },
}));

vi.mock('../api/identityClient', () => ({
  CURRENT_USER_PATH: '/api/users/me',
  getIdentityClient: () => ({ refresh: () => Promise.resolve(null) }),
}));

describe('useOffline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probe.reachable = false;
  });

  afterEach(() => {
    act(() => {
      reportNetworkSuccess();
      connectivity.setSessionOffline(false);
    });
    vi.useRealTimers();
  });

  it('is online by default and lets permitted writes through', () => {
    expect(renderHook(() => useOffline()).result.current).toBe(false);
    expect(renderHook(() => useWritable(true)).result.current).toBe(true);
    expect(renderHook(() => useWritable(false)).result.current).toBe(false);
  });

  it('stays online when a probe answers after one failed request', async () => {
    probe.reachable = true;
    const { result } = renderHook(() => useWritable(true));
    act(() => {
      reportNetworkFailure();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFLINE_GRACE_MS * 2);
    });
    expect(result.current).toBe(true);
  });

  it('holds writes back once the server stays unreachable past the grace period', async () => {
    const { result } = renderHook(() => useWritable(true));
    act(() => {
      reportNetworkFailure();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFLINE_GRACE_MS - 1);
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

  it('goes offline once a session held through an outage outlasts the grace period', async () => {
    const { result } = renderHook(() => useOffline());
    act(() => {
      connectivity.setSessionOffline(true);
    });
    expect(result.current).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFLINE_GRACE_MS);
    });
    expect(result.current).toBe(true);
  });
});
