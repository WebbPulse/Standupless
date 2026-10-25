/**
 * The offline signal: it follows the shared client's reachability and a
 * session refresh that failed at the network layer, and holds writes back
 * while either says the connection is gone.
 */

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reportNetworkFailure,
  reportNetworkSuccess,
} from '@webbpulse/api-client/react';
import { SessionOfflineContext } from '../contexts/SessionOfflineContext';
import { useOffline, useWritable } from './useOffline';

vi.unmock('./useOffline');

/** A wrapper that marks the session as held through a network outage. */
const sessionOffline: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <SessionOfflineContext.Provider value={true}>
    {children}
  </SessionOfflineContext.Provider>
);

describe('useOffline', () => {
  afterEach(() => {
    act(() => {
      reportNetworkSuccess();
    });
  });

  it('is online by default and lets permitted writes through', () => {
    expect(renderHook(() => useOffline()).result.current).toBe(false);
    expect(renderHook(() => useWritable(true)).result.current).toBe(true);
    expect(renderHook(() => useWritable(false)).result.current).toBe(false);
  });

  it('goes offline when a request cannot reach the server', () => {
    const { result } = renderHook(() => useWritable(true));
    act(() => {
      reportNetworkFailure();
    });
    expect(result.current).toBe(false);
    act(() => {
      reportNetworkSuccess();
    });
    expect(result.current).toBe(true);
  });

  it('goes offline while the session is held through an outage', () => {
    const { result } = renderHook(() => useOffline(), {
      wrapper: sessionOffline,
    });
    expect(result.current).toBe(true);
  });
});
