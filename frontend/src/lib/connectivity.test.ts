/**
 * The connectivity monitor: a dropped request or a failed session refresh is
 * probed away without calling the app offline, trouble that outlasts the
 * grace period is reported, the browser's own offline flag is trusted at once,
 * and probes back off while the trouble lasts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectivityMonitor } from './connectivity';

/** A stand in for the shared client's reachability signal. */
const fakeNetwork = () => {
  let online = true;
  const listeners = new Set<(value: boolean) => void>();
  return {
    isNetworkOnline: () => online,
    subscribeNetwork: (listener: (value: boolean) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(value: boolean) {
      if (online === value) return;
      online = value;
      for (const listener of [...listeners]) listener(value);
    },
    listenerCount: () => listeners.size,
  };
};

describe('ConnectivityMonitor', () => {
  let network: ReturnType<typeof fakeNetwork>;
  let browserOnline: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    network = fakeNetwork();
    browserOnline = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const build = (probe: (networkOnline: boolean) => Promise<unknown>) =>
    new ConnectivityMonitor({
      isNetworkOnline: network.isNetworkOnline,
      subscribeNetwork: network.subscribeNetwork,
      browserOnline: () => browserOnline,
      probe,
      graceMs: 15_000,
      baseProbeMs: 1_000,
      maxProbeMs: 8_000,
    });

  it('probes a dropped request away without reporting offline', async () => {
    const probe = vi.fn(() => {
      network.set(true);
      return Promise.resolve();
    });
    const monitor = build(probe);
    const changes = vi.fn();
    monitor.subscribe(changes);

    network.set(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledWith(false);
    expect(monitor.isOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.isOffline()).toBe(false);
    expect(changes).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reports offline only once the trouble outlasts the grace period', async () => {
    const probe = vi.fn(() => Promise.reject(new Error('unreachable')));
    const monitor = build(probe);
    const changes = vi.fn();
    monitor.subscribe(changes);

    network.set(false);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(monitor.isOffline()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.isOffline()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);

    network.set(true);
    expect(monitor.isOffline()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('backs probes off while the trouble lasts and stops once it clears', async () => {
    const probe = vi.fn(() => Promise.reject(new Error('unreachable')));
    const monitor = build(probe);
    monitor.subscribe(() => undefined);

    network.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probe).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(probe).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(probe).toHaveBeenCalledTimes(6);

    network.set(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('trusts the browser offline flag at once and does not probe', async () => {
    const probe = vi.fn(() => Promise.reject(new Error('unreachable')));
    const monitor = build(probe);
    monitor.subscribe(() => undefined);

    browserOnline = false;
    network.set(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.isOffline()).toBe(true);
    expect(probe).not.toHaveBeenCalled();

    browserOnline = true;
    network.set(true);
    expect(monitor.isOffline()).toBe(false);
  });

  it('retries the session refresh when only the session is held', async () => {
    const probe = vi.fn(() => Promise.resolve(null));
    const monitor = build(probe);
    monitor.subscribe(() => undefined);

    monitor.setSessionOffline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(2);

    monitor.setSessionOffline(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(monitor.isOffline()).toBe(false);
  });

  it('reports a session held past the grace period', async () => {
    const monitor = build(() => Promise.resolve(null));
    monitor.subscribe(() => undefined);

    monitor.setSessionOffline(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(monitor.isOffline()).toBe(true);

    monitor.setSessionOffline(false);
    expect(monitor.isOffline()).toBe(false);
  });

  it('probes again at once when the person comes back to the tab', async () => {
    const probe = vi.fn(() => Promise.reject(new Error('unreachable')));
    const monitor = build(probe);
    monitor.subscribe(() => undefined);

    network.set(false);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('lets go of the network signal and its timers with the last subscriber', async () => {
    const probe = vi.fn(() => Promise.reject(new Error('unreachable')));
    const monitor = build(probe);
    const unsubscribe = monitor.subscribe(() => undefined);
    expect(network.listenerCount()).toBe(1);

    network.set(false);
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();

    expect(network.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.isOffline()).toBe(false);
  });
});
