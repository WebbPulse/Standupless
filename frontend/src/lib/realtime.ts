/**
 * Change notices pushed over the workspace WebSocket, turned into query
 * invalidations so an open page shows another person's change in seconds
 * rather than at its next poll.
 *
 * The socket is a hint channel, never a data channel. A notice names what
 * changed (kind, id, team, action) and nothing else, so it only marks the
 * queries reading that thing for a read, and those reads go through the same
 * conditional GETs a poll makes. Polling stays on underneath: a page whose
 * socket is down, or a build with no realtime URL, behaves exactly as before,
 * and a healthy socket only stretches the intervals of the reads its notices
 * cover.
 *
 * Notices arrive in bursts, one per row a write touched, so they are gathered
 * for a moment and flushed as one invalidation of the distinct keys they name.
 * Inbox counts are flushed later still, because the notification rows a change
 * produces are written after the change itself.
 *
 * Most notices name exact keys. Where a notice cannot, because a comment names
 * no issue, a project names no team or a list key carries filters, it names a
 * prefix instead, which is matched against the keys the open page has
 * registered through {@link useLiveQueryKey}.
 *
 * The connection opens with the identity access token in the query string,
 * because a browser cannot set headers on a WebSocket. The URL is never
 * logged. A drop reconnects with jittered exponential backoff, a heartbeat
 * every few minutes keeps the gateway's idle timer from closing the socket and
 * proves the server still holds the connection, and a reconnect after a drop
 * re-reads every registered key, since notices sent while it was down are
 * lost.
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  invalidateQueries,
  serializeQueryKey,
  type QueryKey,
  type QueryKeyPart,
} from '@webbpulse/api-client/react';
import { getIdentityClient } from '../api/identityClient';
import { realtimeUrl } from '../config/app';
import { issueRefs } from './issueRefs';
import {
  activityKey,
  cycleKey,
  cyclesKey,
  inboxCountKey,
  inboxCountsKey,
  initiativeDetailKey,
  initiativeProgressKey,
  initiativesKey,
  issueKey,
  linksKey,
  milestonesKey,
  projectDetailKey,
  projectsKey,
  triageSummaryKey,
} from './queryKeys';

/** The kinds of record a notice can name. */
export type NoticeKind =
  | 'issue'
  | 'comment'
  | 'cycle'
  | 'project'
  | 'initiative';

/** What happened to the record. */
export type NoticeAction = 'created' | 'updated' | 'removed';

/** One change notice, as the socket delivers it. */
export interface ChangeNotice {
  kind: NoticeKind;
  id: string;
  action: NoticeAction;
  workspaceId: string;
  teamId: string | null;
}

/** The keys one notice marks for a read. */
export interface NoticeTargets {
  /** Exact keys, invalidated on the next flush. */
  keys: QueryKey[];
  /** Prefixes matched against the registered live keys on the next flush. */
  prefixes: QueryKey[];
  /** Exact keys invalidated on the later, delayed flush. */
  delayedKeys: QueryKey[];
  /** Prefixes matched on the delayed flush. */
  delayedPrefixes: QueryKey[];
}

const KINDS: readonly NoticeKind[] = [
  'issue',
  'comment',
  'cycle',
  'project',
  'initiative',
];

const ACTIONS: readonly NoticeAction[] = ['created', 'updated', 'removed'];

/** Reads one socket message as a change notice, or null for anything else. */
export const parseNotice = (data: unknown): ChangeNotice | null => {
  let value: unknown = data;
  if (typeof data === 'string') {
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message['type'] !== 'change') return null;
  const { kind, id, action, workspace_id: workspaceId } = message;
  const teamId = message['team_id'];
  if (!KINDS.includes(kind as NoticeKind)) return null;
  if (!ACTIONS.includes(action as NoticeAction)) return null;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof workspaceId !== 'string' || workspaceId === '') return null;
  if (teamId !== null && teamId !== undefined && typeof teamId !== 'string') {
    return null;
  }
  return {
    kind: kind as NoticeKind,
    id,
    action: action as NoticeAction,
    workspaceId,
    teamId: typeof teamId === 'string' && teamId !== '' ? teamId : null,
  };
};

/** The inbox reads a change can move, flushed after the notification rows land. */
const inboxTargets = (
  workspaceId: string
): Pick<NoticeTargets, 'delayedKeys' | 'delayedPrefixes'> => ({
  delayedKeys: [inboxCountKey(workspaceId), inboxCountsKey(workspaceId)],
  delayedPrefixes: [['inbox', workspaceId]],
});

/** Maps one notice to the queries that read what it names. */
export const noticeTargets = (notice: ChangeNotice): NoticeTargets => {
  const { workspaceId: ws, id, teamId } = notice;
  switch (notice.kind) {
    case 'issue':
      return {
        keys: [
          issueKey(ws, id),
          ...issueRefs(ws, id).map((ref) => issueKey(ws, ref)),
          activityKey(id),
          linksKey(id),
          triageSummaryKey(ws),
        ],
        prefixes: [
          ['issue-collection', ws],
          ['issues', ws],
          ['board', ws],
          ['children'],
          ['triage', ws],
          ['cycleIssues', ws],
          ['projectIssues', ws],
        ],
        ...inboxTargets(ws),
      };
    case 'comment':
      return {
        keys: [],
        prefixes: [['comments'], ['activity']],
        ...inboxTargets(ws),
      };
    case 'cycle':
      return {
        keys:
          teamId === null
            ? []
            : [
                cyclesKey(ws, teamId, ''),
                cyclesKey(ws, teamId, 'sub-teams'),
                cycleKey(ws, teamId, id),
                ['cycleRollUp', ws, teamId],
              ],
        prefixes: [
          ['cycles', ws],
          ['cycle', ws],
        ],
        delayedKeys: [],
        delayedPrefixes: [],
      };
    case 'project':
      return {
        keys: [
          projectDetailKey(ws, id),
          projectsKey(ws, '', ''),
          ...(teamId === null ? [] : [projectsKey(ws, teamId, '')]),
          milestonesKey(ws, id),
        ],
        prefixes: [
          ['project', ws, id],
          ['projects', ws],
          ['roadmap', ws],
        ],
        delayedKeys: [],
        delayedPrefixes: [],
      };
    case 'initiative':
      return {
        keys: [
          initiativesKey(ws, ''),
          initiativeDetailKey(ws, id),
          initiativeProgressKey(ws, id),
        ],
        prefixes: [
          ['initiative', ws, id],
          ['initiatives', ws],
          ['roadmap', ws],
        ],
        delayedKeys: [],
        delayedPrefixes: [],
      };
  }
};

/** One registered key, with how many mounted readers hold it. */
interface LiveKey {
  key: readonly QueryKeyPart[];
  holders: number;
}

const liveKeys = new Map<string, LiveKey>();

/**
 * Registers a key the open page is reading, so a notice that can only name a
 * prefix still reaches it. Answers the release; releasing twice is safe.
 */
export const trackLiveKey = (key: QueryKey): (() => void) => {
  const parts: readonly QueryKeyPart[] = typeof key === 'string' ? [key] : key;
  const serialized = serializeQueryKey(key);
  const held = liveKeys.get(serialized);
  if (held === undefined) {
    liveKeys.set(serialized, { key: parts, holders: 1 });
  } else {
    held.holders += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = liveKeys.get(serialized);
    if (current === undefined) return;
    current.holders -= 1;
    if (current.holders <= 0) liveKeys.delete(serialized);
  };
};

/** Registers `key` for as long as the calling component reads it. */
export const useLiveQueryKey = (key: QueryKey, enabled = true): void => {
  const serialized = serializeQueryKey(key);
  useEffect(() => {
    if (!enabled) return undefined;
    const parsed: unknown = serialized.startsWith('[')
      ? JSON.parse(serialized)
      : serialized;
    return trackLiveKey(parsed as QueryKey);
  }, [serialized, enabled]);
};

/** Whether `key` starts with every part of `prefix`. */
const startsWith = (
  key: readonly QueryKeyPart[],
  prefix: readonly QueryKeyPart[]
): boolean =>
  prefix.length <= key.length &&
  prefix.every((part, index) => (part ?? null) === (key[index] ?? null));

/** The registered keys under `prefix`. */
export const liveKeysUnder = (prefix: QueryKey): QueryKey[] => {
  const parts: readonly QueryKeyPart[] =
    typeof prefix === 'string' ? [prefix] : prefix;
  return [...liveKeys.values()]
    .filter((held) => startsWith(held.key, parts))
    .map((held) => held.key);
};

/** Every registered key. */
export const allLiveKeys = (): QueryKey[] =>
  [...liveKeys.values()].map((held) => held.key);

/** Forgets every registered key, for tests. */
export const clearLiveKeysForTests = (): void => {
  liveKeys.clear();
};

let healthy = false;
const healthListeners = new Set<() => void>();

/** Whether a socket is open and answering heartbeats right now. */
export const isRealtimeHealthy = (): boolean => healthy;

/** Hears every change of {@link isRealtimeHealthy}. */
export const subscribeRealtimeHealth = (listener: () => void): (() => void) => {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
};

/** Sets the shared health flag, telling listeners only on a change. */
const setHealthy = (value: boolean): void => {
  if (healthy === value) return;
  healthy = value;
  for (const listener of [...healthListeners]) listener();
};

/** The health flag as React state. */
export const useRealtimeHealthy = (): boolean =>
  useSyncExternalStore(subscribeRealtimeHealth, isRealtimeHealthy, () => false);

/** The part of a WebSocket the connection uses, so tests can hand in a fake. */
export interface SocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** What a {@link RealtimeConnection} is built from. */
export interface RealtimeOptions {
  url: string;
  workspaceId: string;
  /** The access token to connect with, refreshed first when `refresh` is set. */
  getToken: (refresh: boolean) => Promise<string | null>;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  /** Receives each flush's distinct keys; defaults to `invalidateQueries`. */
  invalidate?: (keys: QueryKey[]) => void;
  flushMs?: number;
  delayedFlushMs?: number;
  heartbeatMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/** How long notices gather before one flush. */
export const NOTICE_FLUSH_MS = 500;

/** How long inbox reads wait, for the notification rows to land. */
export const INBOX_FLUSH_MS = 2500;

/** How often a heartbeat goes out, inside the gateway's ten minute idle limit. */
export const HEARTBEAT_MS = 5 * 60 * 1000;

/** The first reconnect wait. */
export const BASE_BACKOFF_MS = 1000;

/** The longest reconnect wait. */
export const MAX_BACKOFF_MS = 60 * 1000;

const OPEN = 1;

/** Closes a socket that may already be closing, which some browsers throw on. */
const closeQuietly = (
  socket: SocketLike,
  code: number,
  reason: string
): boolean => {
  try {
    socket.close(code, reason);
    return true;
  } catch {
    return false;
  }
};

/**
 * One workspace's socket, reconnecting until stopped. It holds no React state;
 * {@link useRealtime} owns one per mounted workspace.
 */
export class RealtimeConnection {
  private readonly options: Required<Omit<RealtimeOptions, 'createSocket'>> & {
    createSocket: (url: string) => SocketLike;
  };
  private socket: SocketLike | null = null;
  private stopped = true;
  private attempts = 0;
  private refreshNext = false;
  private everOpened = false;
  private awaitingPong = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private delayedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, QueryKey>();
  private readonly pendingPrefixes = new Map<string, QueryKey>();
  private readonly delayed = new Map<string, QueryKey>();
  private readonly delayedPrefixes = new Map<string, QueryKey>();
  private readonly onOnline = (): void => {
    if (this.stopped || this.socket !== null) return;
    this.clearReconnect();
    this.attempts = 0;
    void this.connect();
  };

  constructor(options: RealtimeOptions) {
    this.options = {
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      random: Math.random,
      invalidate: (keys) => {
        for (const key of keys) invalidateQueries(key);
      },
      flushMs: NOTICE_FLUSH_MS,
      delayedFlushMs: INBOX_FLUSH_MS,
      heartbeatMs: HEARTBEAT_MS,
      baseBackoffMs: BASE_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      ...options,
    };
  }

  /** Opens the socket and keeps it open until {@link stop}. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
    }
    void this.connect();
  }

  /** Closes the socket for good and drops anything not yet flushed. */
  stop(): void {
    this.stopped = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
    }
    this.clearReconnect();
    this.stopHeartbeat();
    for (const timer of [this.flushTimer, this.delayedTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.flushTimer = null;
    this.delayedTimer = null;
    this.pending.clear();
    this.pendingPrefixes.clear();
    this.delayed.clear();
    this.delayedPrefixes.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      closeQuietly(socket, 1000, 'closed');
    }
    setHealthy(false);
  }

  /** The wait before the next attempt, jittered between half and all of it. */
  backoffMs(): number {
    const { baseBackoffMs, maxBackoffMs, random } = this.options;
    const ceiling = Math.min(maxBackoffMs, baseBackoffMs * 2 ** this.attempts);
    return Math.round(ceiling * (0.5 + random() * 0.5));
  }

  /** Asks for a token and opens one socket with it. */
  private async connect(): Promise<void> {
    if (this.stopped) return;
    const refresh = this.refreshNext;
    this.refreshNext = false;
    let token: string | null = null;
    try {
      token = await this.options.getToken(refresh);
    } catch {
      token = null;
    }
    if (this.stopped) return;
    if (token === null || token === '') {
      this.scheduleReconnect();
      return;
    }
    const query = new URLSearchParams({
      token,
      workspace_id: this.options.workspaceId,
    });
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(
        `${this.options.url}?${query.toString()}`
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.attempts = 0;
      this.awaitingPong = false;
      setHealthy(true);
      this.startHeartbeat();
      if (this.everOpened) this.resync();
      this.everOpened = true;
    };
    socket.onmessage = (event) => {
      this.receive(event.data);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      setHealthy(false);
      if (!opened) this.refreshNext = true;
      this.scheduleReconnect();
    };
  }

  /** Waits out the backoff, then tries again. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const wait = this.backoffMs();
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
  }

  /** Cancels a waiting reconnect. */
  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Drops the current socket and reconnects, for a socket the server forgot. */
  private restart(): void {
    const socket = this.socket;
    if (socket === null) return;
    this.socket = null;
    socket.onclose = null;
    this.stopHeartbeat();
    setHealthy(false);
    closeQuietly(socket, 4000, 'stale');
    this.scheduleReconnect();
  }

  /** Sends a heartbeat on a timer, restarting when the last one went unanswered. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (socket === null || socket.readyState !== OPEN) return;
      if (this.awaitingPong) {
        this.restart();
        return;
      }
      this.awaitingPong = true;
      try {
        socket.send(JSON.stringify({ action: 'heartbeat' }));
      } catch {
        this.restart();
      }
    }, this.options.heartbeatMs);
  }

  /** Stops the heartbeat timer. */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** Handles one message: a pong, a notice for this workspace, or nothing. */
  private receive(data: unknown): void {
    let value: unknown = data;
    if (typeof data === 'string') {
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (typeof value === 'object' && value !== null) {
      const message = value as Record<string, unknown>;
      if (message['action'] === 'pong') {
        this.awaitingPong = false;
        if (message['connected'] === false) this.restart();
        return;
      }
    }
    const notice = parseNotice(value);
    if (notice === null || notice.workspaceId !== this.options.workspaceId) {
      return;
    }
    this.enqueue(noticeTargets(notice));
  }

  /** Gathers one notice's targets into the next flushes. */
  private enqueue(targets: NoticeTargets): void {
    const add = (into: Map<string, QueryKey>, keys: QueryKey[]): void => {
      for (const key of keys) into.set(serializeQueryKey(key), key);
    };
    add(this.pending, targets.keys);
    add(this.pendingPrefixes, targets.prefixes);
    add(this.delayed, targets.delayedKeys);
    add(this.delayedPrefixes, targets.delayedPrefixes);
    if (
      this.flushTimer === null &&
      (this.pending.size > 0 || this.pendingPrefixes.size > 0)
    ) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush(this.pending, this.pendingPrefixes);
      }, this.options.flushMs);
    }
    if (
      this.delayedTimer === null &&
      (this.delayed.size > 0 || this.delayedPrefixes.size > 0)
    ) {
      this.delayedTimer = setTimeout(() => {
        this.delayedTimer = null;
        this.flush(this.delayed, this.delayedPrefixes);
      }, this.options.delayedFlushMs);
    }
  }

  /** Invalidates the gathered keys and the live keys under the gathered prefixes. */
  private flush(
    keys: Map<string, QueryKey>,
    prefixes: Map<string, QueryKey>
  ): void {
    const out = new Map(keys);
    for (const prefix of prefixes.values()) {
      for (const key of liveKeysUnder(prefix)) {
        out.set(serializeQueryKey(key), key);
      }
    }
    keys.clear();
    prefixes.clear();
    this.options.invalidate([...out.values()]);
  }

  /** Re-reads everything the page holds, after a gap in which notices were lost. */
  private resync(): void {
    const ws = this.options.workspaceId;
    this.enqueue({
      keys: [...allLiveKeys(), triageSummaryKey(ws)],
      prefixes: [],
      delayedKeys: [inboxCountKey(ws), inboxCountsKey(ws)],
      delayedPrefixes: [],
    });
  }
}

/** The token to connect with, from the shared identity client. */
const identityToken = async (refresh: boolean): Promise<string | null> => {
  const auth = getIdentityClient();
  if (auth === null) return null;
  if (refresh) return auth.refresh();
  return auth.getAccessToken() ?? auth.waitForToken();
};

/**
 * Holds a socket open for `workspaceId` while mounted. A build with no
 * realtime URL, or no workspace yet, opens nothing and leaves polling alone.
 */
export const useRealtime = (
  workspaceId: string | null | undefined,
  url: string = realtimeUrl
): void => {
  useEffect(() => {
    if (url === '' || !workspaceId || typeof WebSocket === 'undefined') {
      return undefined;
    }
    const connection = new RealtimeConnection({
      url,
      workspaceId,
      getToken: identityToken,
    });
    connection.start();
    return () => connection.stop();
  }, [workspaceId, url]);
};
