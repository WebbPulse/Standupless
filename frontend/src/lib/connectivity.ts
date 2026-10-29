/**
 * Whether the app is offline in a way worth telling the person about. The
 * shared client marks the app offline on the first request that fails at the
 * network layer, and the identity client parks a refresh that failed the same
 * way, and both stay put until some later answer proves the network is back.
 * On an idle page polls stretch to minutes, so a single dropped request after
 * a laptop wakes, or one refresh that hit a cold gateway, used to leave the
 * offline notice up long after the connection was fine.
 *
 * This monitor sits between those raw signals and the notice. When either one
 * reports trouble while the browser still says it is online, it probes the
 * API at once and again with exponential backoff, so a blip is disproved in
 * about a second, and only calls the app offline when the trouble outlasts a
 * grace period. The browser's own offline event is trusted at once. Coming
 * back to the tab or focusing it probes again, and once a probe gets any
 * answer the shared client flips back online, the identity client retries its
 * refresh, and the polled reads and the realtime socket catch up on their own.
 */

import { isOnline, subscribeToOnline } from '@webbpulse/api-client/react';
import { useSyncExternalStore } from 'react';

/** How long the trouble must last before the app is called offline. */
export const OFFLINE_GRACE_MS = 15_000;

/** The wait before the second probe, doubled after each one that fails. */
export const PROBE_BASE_MS = 1_000;

/** The longest wait between probes while the trouble lasts. */
export const PROBE_MAX_MS = 30_000;

/** What a {@link ConnectivityMonitor} reads and calls. */
export interface ConnectivityOptions {
  /** The shared client's reachability. */
  isNetworkOnline?: () => boolean;
  /** Hears each change of the shared client's reachability. */
  subscribeNetwork?: (listener: (online: boolean) => void) => () => void;
  /** What the browser says about its connection. */
  browserOnline?: () => boolean;
  /**
   * One reachability check. `networkOnline` says whether only the session is
   * in trouble, in which case the check retries the session refresh.
   */
  probe?: (networkOnline: boolean) => Promise<unknown>;
  graceMs?: number;
  baseProbeMs?: number;
  maxProbeMs?: number;
}

/** The browser's connection flag, or true where there is none. */
const navigatorOnline = (): boolean =>
  typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * Asks the API for the signed in profile, whose answer of any status proves
 * the network, or retries the session refresh when only the session is held.
 */
const defaultProbe = async (networkOnline: boolean): Promise<unknown> => {
  if (networkOnline) {
    const { getIdentityClient } = await import('../api/identityClient');
    return getIdentityClient()?.refresh();
  }
  const [{ apiClient }, { CURRENT_USER_PATH }] = await Promise.all([
    import('../api/client'),
    import('../api/identityClient'),
  ]);
  return apiClient.get(CURRENT_USER_PATH, { retries: 0 });
};

/**
 * Turns the raw reachability signals into a confirmed offline flag, probing
 * the API while they report trouble. Started with the first subscriber and
 * stopped with the last.
 */
export class ConnectivityMonitor {
  private readonly isNetworkOnline: () => boolean;
  private readonly subscribeNetwork: (
    listener: (online: boolean) => void
  ) => () => void;
  private readonly browserOnline: () => boolean;
  private readonly probe: (networkOnline: boolean) => Promise<unknown>;
  private readonly graceMs: number;
  private readonly baseProbeMs: number;
  private readonly maxProbeMs: number;
  private readonly listeners = new Set<() => void>();
  private networkOnline = true;
  private sessionOffline = false;
  private offline = false;
  private attempts = 0;
  private probing = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopNetwork: (() => void) | null = null;

  constructor(options: ConnectivityOptions = {}) {
    this.isNetworkOnline = options.isNetworkOnline ?? isOnline;
    this.subscribeNetwork = options.subscribeNetwork ?? subscribeToOnline;
    this.browserOnline = options.browserOnline ?? navigatorOnline;
    this.probe = options.probe ?? defaultProbe;
    this.graceMs = options.graceMs ?? OFFLINE_GRACE_MS;
    this.baseProbeMs = options.baseProbeMs ?? PROBE_BASE_MS;
    this.maxProbeMs = options.maxProbeMs ?? PROBE_MAX_MS;
  }

  private readonly onReturn = (): void => {
    if (typeof document !== 'undefined' && document.hidden) return;
    this.probeNow();
  };

  /** Whether the app is confirmed offline. */
  readonly isOffline = (): boolean => this.offline;

  /** Hears each change of {@link isOffline}, starting the monitor if needed. */
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) this.start();
    this.listeners.add(listener);
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.stop();
    };
  };

  /** Records whether the session is held through a failed refresh. */
  setSessionOffline(value: boolean): void {
    if (this.sessionOffline === value) return;
    this.sessionOffline = value;
    if (this.stopNetwork !== null) this.update();
  }

  /** Probes at once, dropping any backoff, while there is trouble. */
  probeNow(): void {
    if (!this.troubled()) return;
    this.clearProbe();
    this.attempts = 0;
    void this.runProbe();
  }

  private start(): void {
    this.networkOnline = this.isNetworkOnline();
    this.stopNetwork = this.subscribeNetwork((online) => {
      this.networkOnline = online;
      this.update();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.onReturn);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onReturn);
    }
    this.update();
  }

  private stop(): void {
    this.stopNetwork?.();
    this.stopNetwork = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.onReturn);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onReturn);
    }
    this.clearGrace();
    this.clearProbe();
    this.attempts = 0;
    this.offline = false;
  }

  private troubled(): boolean {
    return !this.networkOnline || this.sessionOffline;
  }

  private update(): void {
    if (!this.troubled()) {
      this.clearGrace();
      this.clearProbe();
      this.attempts = 0;
      this.setOffline(false);
      return;
    }
    if (!this.browserOnline()) {
      this.clearGrace();
      this.clearProbe();
      this.setOffline(true);
      return;
    }
    if (!this.offline && this.graceTimer === null) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.troubled()) this.setOffline(true);
      }, this.graceMs);
    }
    if (this.probeTimer === null && !this.probing) {
      this.attempts = 0;
      void this.runProbe();
    }
  }

  private async runProbe(): Promise<void> {
    if (this.probing || !this.troubled() || !this.browserOnline()) return;
    this.probing = true;
    try {
      await this.probe(this.networkOnline);
    } catch {
      void 0;
    } finally {
      this.probing = false;
    }
    if (this.stopNetwork === null || !this.troubled()) return;
    if (this.probeTimer !== null) return;
    const wait = Math.min(
      this.maxProbeMs,
      this.baseProbeMs * 2 ** this.attempts
    );
    this.attempts += 1;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      void this.runProbe();
    }, wait);
  }

  private setOffline(value: boolean): void {
    if (this.offline === value) return;
    this.offline = value;
    for (const listener of [...this.listeners]) listener();
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private clearProbe(): void {
    if (this.probeTimer !== null) clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }
}

/** The one monitor the app reads. */
export const connectivity = new ConnectivityMonitor();

/** Whether the app is confirmed offline, re-rendering when it changes. */
export const useConfirmedOffline = (): boolean =>
  useSyncExternalStore(
    connectivity.subscribe,
    connectivity.isOffline,
    () => false
  );
