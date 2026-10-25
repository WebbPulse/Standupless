/**
 * The change socket client: reading notices, mapping them to query keys,
 * matching prefixes against the live keys, gathering a burst into one flush,
 * reconnecting with backoff, the heartbeat, and the shared health flag.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeQueryKey, type QueryKey } from '@webbpulse/api-client/react';
import { clearIssueRefs, rememberIssueRef } from './issueRefs';
import {
  RealtimeConnection,
  clearLiveKeysForTests,
  isRealtimeHealthy,
  liveKeysUnder,
  noticeTargets,
  parseNotice,
  subscribeRealtimeHealth,
  trackLiveKey,
  type ChangeNotice,
  type SocketLike,
} from './realtime';

/** A socket the test drives by hand. */
class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null =
    null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  /** Completes the handshake. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Delivers one message. */
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Drops the connection from the server side. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const WS = 'ws-1';

/** One wire notice for the workspace under test. */
const wire = (overrides: Record<string, unknown> = {}) => ({
  type: 'change',
  kind: 'issue',
  id: 'iss-1',
  action: 'updated',
  workspace_id: WS,
  team_id: 'team-1',
  ...overrides,
});

/** The serialized forms of a list of keys, for order free comparison. */
const serialized = (keys: QueryKey[]): string[] =>
  keys.map((key) => serializeQueryKey(key)).sort();

describe('parseNotice', () => {
  it('reads a change notice from text', () => {
    expect(parseNotice(JSON.stringify(wire()))).toEqual<ChangeNotice>({
      kind: 'issue',
      id: 'iss-1',
      action: 'updated',
      workspaceId: WS,
      teamId: 'team-1',
    });
  });

  it('takes a missing team as null', () => {
    expect(parseNotice(wire({ kind: 'project', team_id: null }))?.teamId).toBe(
      null
    );
  });

  it.each([
    ['not json', '{'],
    ['a pong', { action: 'pong', connected: true }],
    ['an unknown kind', wire({ kind: 'label' })],
    ['an unknown action', wire({ action: 'moved' })],
    ['an empty id', wire({ id: '' })],
    ['no workspace', wire({ workspace_id: undefined })],
    ['a numeric team', wire({ team_id: 3 })],
  ])('ignores %s', (_label, data) => {
    expect(parseNotice(data)).toBeNull();
  });
});

describe('noticeTargets', () => {
  afterEach(() => {
    clearIssueRefs();
  });

  it('names the issue under its id and every key text it was read by', () => {
    rememberIssueRef(WS, 'iss-1', 'ENG-12');
    const targets = noticeTargets(parseNotice(wire())!);
    expect(serialized(targets.keys)).toEqual(
      serialized([
        ['issue', WS, 'iss-1'],
        ['issue', WS, 'ENG-12'],
        ['activity', 'iss-1'],
        ['links', 'iss-1'],
        ['triage-summary', WS],
      ])
    );
    expect(targets.prefixes).toContainEqual(['issue-collection', WS]);
    expect(serialized(targets.delayedKeys)).toEqual(
      serialized([
        ['inbox-count', WS],
        ['inbox-counts', WS],
      ])
    );
  });

  it('reaches a comment through the comment and activity prefixes', () => {
    const targets = noticeTargets(parseNotice(wire({ kind: 'comment' }))!);
    expect(targets.keys).toEqual([]);
    expect(targets.prefixes).toEqual([['comments'], ['activity']]);
  });

  it('names a cycle under its team', () => {
    const targets = noticeTargets(
      parseNotice(wire({ kind: 'cycle', id: 'cyc-1' }))!
    );
    expect(targets.keys).toContainEqual(['cycle', WS, 'team-1', 'cyc-1']);
    expect(targets.keys).toContainEqual(['cycles', WS, 'team-1', '']);
  });

  it('names a teamless project by its own keys and prefixes', () => {
    const targets = noticeTargets(
      parseNotice(wire({ kind: 'project', id: 'prj-1', team_id: null }))!
    );
    expect(targets.keys).toContainEqual(['project', WS, 'prj-1']);
    expect(targets.prefixes).toContainEqual(['projects', WS]);
  });

  it('names an initiative', () => {
    const targets = noticeTargets(
      parseNotice(wire({ kind: 'initiative', id: 'ini-1' }))!
    );
    expect(targets.keys).toContainEqual(['initiative', WS, 'ini-1']);
  });
});

describe('live keys', () => {
  afterEach(() => {
    clearLiveKeysForTests();
  });

  it('matches a prefix part by part and forgets a released key', () => {
    const release = trackLiveKey(['issue-collection', WS, 'team', '{}']);
    trackLiveKey(['issue-collection', 'ws-2', 'team', '{}']);
    trackLiveKey(['issues', WS]);
    expect(liveKeysUnder(['issue-collection', WS])).toEqual([
      ['issue-collection', WS, 'team', '{}'],
    ]);
    release();
    release();
    expect(liveKeysUnder(['issue-collection', WS])).toEqual([]);
  });

  it('keeps a key held twice until both release it', () => {
    const first = trackLiveKey(['comments', 'iss-1']);
    const second = trackLiveKey(['comments', 'iss-1']);
    first();
    expect(liveKeysUnder(['comments'])).toHaveLength(1);
    second();
    expect(liveKeysUnder(['comments'])).toHaveLength(0);
  });
});

describe('RealtimeConnection', () => {
  let sockets: FakeSocket[];
  let invalidated: QueryKey[][];
  let tokens: boolean[];
  let connection: RealtimeConnection;

  /** The newest socket the connection opened. */
  const latest = (): FakeSocket => sockets[sockets.length - 1]!;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    invalidated = [];
    tokens = [];
    connection = new RealtimeConnection({
      url: 'wss://realtime.example/staging',
      workspaceId: WS,
      getToken: (refresh) => {
        tokens.push(refresh);
        return Promise.resolve('tok');
      },
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      random: () => 1,
      invalidate: (keys) => {
        invalidated.push(keys);
      },
      flushMs: 500,
      delayedFlushMs: 2500,
      heartbeatMs: 1000,
      baseBackoffMs: 1000,
      maxBackoffMs: 8000,
    });
  });

  afterEach(() => {
    connection.stop();
    clearLiveKeysForTests();
    clearIssueRefs();
    vi.useRealTimers();
  });

  it('connects with the token and workspace in the query string', async () => {
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    const url = new URL(latest().url);
    expect(url.origin + url.pathname).toBe('wss://realtime.example/staging');
    expect(url.searchParams.get('token')).toBe('tok');
    expect(url.searchParams.get('workspace_id')).toBe(WS);
  });

  it('flushes a burst of notices as one invalidation of distinct keys', async () => {
    trackLiveKey(['issue-collection', WS, 'team', '{}']);
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().open();
    latest().deliver(wire());
    latest().deliver(wire());
    latest().deliver(wire({ workspace_id: 'other' }));
    await vi.advanceTimersByTimeAsync(499);
    expect(invalidated).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidated).toHaveLength(1);
    const keys = serialized(invalidated[0]!);
    expect(keys).toContain(serializeQueryKey(['issue', WS, 'iss-1']));
    expect(keys).toContain(
      serializeQueryKey(['issue-collection', WS, 'team', '{}'])
    );
    expect(new Set(keys).size).toBe(keys.length);
    await vi.advanceTimersByTimeAsync(2000);
    expect(invalidated).toHaveLength(2);
    expect(invalidated[1]).toContainEqual(['inbox-count', WS]);
  });

  it('reconnects with doubling backoff and refreshes the token after a refused handshake', async () => {
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().drop();
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    expect(tokens).toEqual([false, true]);
    latest().drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
  });

  it('re-reads every live key after a reconnect', async () => {
    trackLiveKey(['comments', 'iss-9']);
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().open();
    latest().drop();
    await vi.advanceTimersByTimeAsync(1000);
    latest().open();
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidated[0]).toContainEqual(['comments', 'iss-9']);
    expect(invalidated[0]).toContainEqual(['triage-summary', WS]);
  });

  it('sends heartbeats and restarts when one goes unanswered', async () => {
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = latest();
    first.open();
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.sent).toEqual([JSON.stringify({ action: 'heartbeat' })]);
    first.deliver({ action: 'pong', connected: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.closed?.code).toBe(4000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });

  it('restarts when the server says it no longer holds the connection', async () => {
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().open();
    latest().deliver({ action: 'pong', connected: false });
    expect(sockets[0]!.closed?.code).toBe(4000);
  });

  it('reports health while open and stops cleanly', async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeRealtimeHealth(heard);
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(isRealtimeHealthy()).toBe(false);
    latest().open();
    expect(isRealtimeHealthy()).toBe(true);
    connection.stop();
    expect(isRealtimeHealthy()).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(sockets[0]!.closed?.code).toBe(1000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(1);
    unsubscribe();
  });

  it('waits and retries when no token is available', async () => {
    const tokenless = new RealtimeConnection({
      url: 'wss://realtime.example/staging',
      workspaceId: WS,
      getToken: () => Promise.resolve(null),
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      random: () => 1,
      baseBackoffMs: 1000,
    });
    tokenless.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(0);
    tokenless.stop();
  });
});
