/**
 * The presence store: what goes out on open, heartbeat, editing and close, the
 * throttle, the resend on reconnect, the lists it keeps, that nothing shows
 * without a socket, and that the change connection hands it the socket and the
 * viewer lists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_MIN_GAP_MS,
  attachPresenceTransport,
  detachPresenceTransport,
  openPresence,
  parsePresence,
  presenceViewers,
  receivePresence,
  resetPresenceForTests,
  subscribePresence,
} from './presence';
import { RealtimeConnection, type SocketLike } from './realtime';

const WS = 'ws-1';

const OWNER = {};

/** One viewer list as the server sends it. */
const list = (
  viewers: { user_id: string; editing: boolean }[],
  overrides: Record<string, unknown> = {}
) => ({
  type: 'presence',
  workspace_id: WS,
  kind: 'issue',
  id: 'iss-1',
  viewers,
  ...overrides,
});

describe('presence', () => {
  let sent: Record<string, unknown>[];

  /** Attaches a socket that records what is sent on it. */
  const attach = (): void => {
    attachPresenceTransport(OWNER, WS, (data) => {
      sent.push(JSON.parse(data) as Record<string, unknown>);
      return true;
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetPresenceForTests();
    sent = [];
  });

  afterEach(() => {
    resetPresenceForTests();
    vi.useRealTimers();
  });

  it('reads a viewer list and drops anything else', () => {
    expect(
      parsePresence(
        list([
          { user_id: 'u-1', editing: true },
          { user_id: 'u-1', editing: false },
          { user_id: 'u-2', editing: false },
        ])
      )?.viewers
    ).toEqual([
      { userId: 'u-1', editing: true },
      { userId: 'u-2', editing: false },
    ]);
    expect(parsePresence({ type: 'change' })).toBeNull();
    expect(parsePresence(list([], { kind: 'cycle' }))).toBeNull();
    expect(parsePresence(list([], { viewers: 'nope' }))).toBeNull();
  });

  it('sends on open, every half minute, and a leave on close', () => {
    attach();
    const presence = openPresence('issue', 'iss-1');
    expect(sent).toEqual([
      { action: 'presence', kind: 'issue', id: 'iss-1', editing: false },
    ]);
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
    expect(sent).toHaveLength(2);
    presence.close();
    expect(sent[2]).toEqual({
      action: 'presence_leave',
      kind: 'issue',
      id: 'iss-1',
    });
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2);
    expect(sent).toHaveLength(3);
  });

  it('throttles editing flips to one message a gap, sending the last state', () => {
    attach();
    const presence = openPresence('issue', 'iss-1');
    presence.setEditing(true);
    presence.setEditing(false);
    presence.setEditing(true);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(PRESENCE_MIN_GAP_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ editing: true });
  });

  it('skips the trailing send when the state settled back to what went', () => {
    attach();
    const presence = openPresence('issue', 'iss-1');
    presence.setEditing(true);
    presence.setEditing(false);
    vi.advanceTimersByTime(PRESENCE_MIN_GAP_MS);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing without a socket and resends everything open on attach', () => {
    openPresence('issue', 'iss-1');
    openPresence('document', 'doc-1');
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
    expect(sent).toEqual([]);
    attach();
    expect(sent.map((message) => message['id'])).toEqual(['iss-1', 'doc-1']);
  });

  it('keeps an entity open until its last holder closes', () => {
    attach();
    const page = openPresence('issue', 'iss-1');
    const peek = openPresence('issue', 'iss-1');
    expect(sent).toHaveLength(1);
    peek.setEditing(true);
    vi.advanceTimersByTime(PRESENCE_MIN_GAP_MS);
    page.close();
    expect(sent.some((message) => message['action'] === 'presence_leave')).toBe(
      false
    );
    peek.close();
    expect(sent[sent.length - 1]).toMatchObject({ action: 'presence_leave' });
  });

  it('keeps the lists of open entities and empties them when the socket goes', () => {
    attach();
    const presence = openPresence('issue', 'iss-1');
    const heard = vi.fn();
    subscribePresence(heard);
    expect(receivePresence(list([{ user_id: 'u-2', editing: true }]))).toBe(
      true
    );
    expect(presenceViewers('issue', 'iss-1')).toEqual([
      { userId: 'u-2', editing: true },
    ]);
    expect(heard).toHaveBeenCalledTimes(1);
    receivePresence(
      list([{ user_id: 'u-3', editing: false }], { id: 'other' })
    );
    receivePresence(
      list([{ user_id: 'u-3', editing: false }], { workspace_id: 'ws-2' })
    );
    expect(presenceViewers('issue', 'other')).toEqual([]);
    detachPresenceTransport({});
    expect(presenceViewers('issue', 'iss-1')).toHaveLength(1);
    detachPresenceTransport(OWNER);
    expect(presenceViewers('issue', 'iss-1')).toEqual([]);
    presence.close();
  });
});

/** A socket the test opens and feeds by hand. */
class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

describe('presence over the change connection', () => {
  afterEach(() => {
    resetPresenceForTests();
    vi.useRealTimers();
  });

  it('sends on the socket once it opens, reads lists, and clears them on a drop', async () => {
    vi.useFakeTimers();
    resetPresenceForTests();
    const sockets: FakeSocket[] = [];
    const invalidate = vi.fn();
    const connection = new RealtimeConnection({
      url: 'wss://realtime.example/staging',
      workspaceId: WS,
      getToken: () => Promise.resolve('tok'),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 1,
      invalidate,
    });
    const presence = openPresence('issue', 'iss-1');
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]!;
    socket.readyState = 1;
    socket.onopen?.({});
    expect(socket.sent.map((data) => JSON.parse(data) as unknown)).toEqual([
      { action: 'presence', kind: 'issue', id: 'iss-1', editing: false },
    ]);
    socket.onmessage?.({
      data: JSON.stringify(list([{ user_id: 'u-2', editing: false }])),
    });
    expect(presenceViewers('issue', 'iss-1')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidate).not.toHaveBeenCalled();
    socket.readyState = 3;
    socket.onclose?.({});
    expect(presenceViewers('issue', 'iss-1')).toEqual([]);
    presence.close();
    connection.stop();
  });
});
