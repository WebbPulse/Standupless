/**
 * Who else has an issue or a document open, over the workspace WebSocket.
 *
 * A page that shows an issue or a document opens a presence for it. While the
 * socket is up, the client tells the server when the page opens, every half
 * minute while it stays open, whenever the editing flag flips, and when it
 * closes. The message names the entity's kind and id and whether the person is
 * editing, and nothing more. The server answers with the other viewers and
 * pushes a fresh list to everyone on the entity when that list changes.
 *
 * Messages are throttled per entity, so a flag flipping on every keystroke
 * still sends at most one message every {@link PRESENCE_MIN_GAP_MS}, with the
 * last state sent once the gap is over.
 *
 * Without a socket nothing is sent and every list is empty, so a page shows no
 * one rather than a list that may be stale. A reconnect sends every open
 * presence again at once.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

/** The kinds of page that report presence. */
export type PresenceKind = 'issue' | 'document';

/** One other person on an entity, and whether they are editing it. */
export interface PresenceViewer {
  userId: string;
  editing: boolean;
}

/** How often an open presence is refreshed, inside the server's minute TTL. */
export const PRESENCE_HEARTBEAT_MS = 30 * 1000;

/** The shortest gap between two messages about one entity. */
export const PRESENCE_MIN_GAP_MS = 2 * 1000;

/** Sends one message on the socket, answering whether it went. */
export type PresenceSend = (data: string) => boolean;

/** One open entity, held by every mounted page showing it. */
interface OpenPresence {
  kind: PresenceKind;
  id: string;
  holders: Map<number, boolean>;
  lastSentAt: number;
  sentEditing: boolean | null;
  trailing: ReturnType<typeof setTimeout> | null;
}

/** The socket presence messages go out on, and which connection owns it. */
interface Transport {
  owner: object;
  workspaceId: string;
  send: PresenceSend;
}

const EMPTY: readonly PresenceViewer[] = Object.freeze([]);

const opened = new Map<string, OpenPresence>();
const viewers = new Map<string, readonly PresenceViewer[]>();
const listeners = new Set<() => void>();
let transport: Transport | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let nextHolder = 1;
let clock: () => number = () => Date.now();

/** The map key of one entity. */
const keyOf = (kind: PresenceKind, id: string): string => `${kind}:${id}`;

/** Tells every listener the viewer lists changed. */
const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Whether any holder of an open entity is editing it. */
const editingOf = (entry: OpenPresence): boolean =>
  [...entry.holders.values()].some(Boolean);

/** Sends one message if a socket is attached, answering whether it went. */
const transmit = (message: Record<string, unknown>): boolean => {
  if (transport === null) return false;
  try {
    return transport.send(JSON.stringify(message));
  } catch {
    return false;
  }
};

/** Cancels an entity's pending trailing send. */
const cancelTrailing = (entry: OpenPresence): void => {
  if (entry.trailing !== null) clearTimeout(entry.trailing);
  entry.trailing = null;
};

/** Sends an entity's current state now, recording when it went. */
const sendNow = (entry: OpenPresence): void => {
  cancelTrailing(entry);
  const editing = editingOf(entry);
  if (
    transmit({ action: 'presence', kind: entry.kind, id: entry.id, editing })
  ) {
    entry.lastSentAt = clock();
    entry.sentEditing = editing;
  }
};

/** Sends an entity's state now, or once the throttle gap is over. */
const sendThrottled = (entry: OpenPresence): void => {
  if (transport === null) return;
  const wait = entry.lastSentAt + PRESENCE_MIN_GAP_MS - clock();
  if (wait <= 0) {
    sendNow(entry);
    return;
  }
  if (entry.trailing !== null) return;
  entry.trailing = setTimeout(() => {
    entry.trailing = null;
    if (opened.get(keyOf(entry.kind, entry.id)) !== entry) return;
    if (entry.sentEditing === editingOf(entry)) return;
    sendNow(entry);
  }, wait);
};

/** Starts the half minute refresh while anything is open on a live socket. */
const syncHeartbeat = (): void => {
  const wanted = transport !== null && opened.size > 0;
  if (wanted && heartbeat === null) {
    heartbeat = setInterval(() => {
      for (const entry of opened.values()) sendNow(entry);
    }, PRESENCE_HEARTBEAT_MS);
  } else if (!wanted && heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
};

/**
 * Hands the presence store a live socket, and sends every open presence on it
 * at once. `owner` is the connection, so only it can take the socket away.
 */
export const attachPresenceTransport = (
  owner: object,
  workspaceId: string,
  send: PresenceSend
): void => {
  transport = { owner, workspaceId, send };
  for (const entry of opened.values()) {
    entry.lastSentAt = 0;
    sendNow(entry);
  }
  syncHeartbeat();
};

/** Takes the socket away from the store and empties every list, so nothing stale shows. */
export const detachPresenceTransport = (owner: object): void => {
  if (transport === null || transport.owner !== owner) return;
  transport = null;
  for (const entry of opened.values()) {
    cancelTrailing(entry);
    entry.sentEditing = null;
  }
  syncHeartbeat();
  if (viewers.size > 0) {
    viewers.clear();
    notify();
  }
};

/** Reads one socket message as a viewer list, or null for anything else. */
export const parsePresence = (
  value: unknown
): {
  workspaceId: string;
  kind: PresenceKind;
  id: string;
  viewers: PresenceViewer[];
} | null => {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message['type'] !== 'presence') return null;
  const { kind, id, workspace_id: workspaceId } = message;
  const listed = message['viewers'];
  if (kind !== 'issue' && kind !== 'document') return null;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof workspaceId !== 'string' || workspaceId === '') return null;
  if (!Array.isArray(listed)) return null;
  const seen = new Set<string>();
  const out: PresenceViewer[] = [];
  for (const item of listed) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const userId = row['user_id'];
    if (typeof userId !== 'string' || userId === '' || seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    out.push({ userId, editing: row['editing'] === true });
  }
  return { workspaceId, kind, id, viewers: out };
};

/**
 * Takes one parsed socket message. Answers whether it was a presence message,
 * so the connection knows not to read it as a change notice.
 */
export const receivePresence = (value: unknown): boolean => {
  const message = parsePresence(value);
  if (message === null) return false;
  if (transport === null || message.workspaceId !== transport.workspaceId) {
    return true;
  }
  const key = keyOf(message.kind, message.id);
  if (!opened.has(key)) return true;
  viewers.set(key, message.viewers);
  notify();
  return true;
};

/**
 * Opens a presence for one entity and answers its controls: set the editing
 * flag, and close. Several pages may hold the same entity; it is left only
 * when the last one closes.
 */
export const openPresence = (
  kind: PresenceKind,
  id: string
): { setEditing: (editing: boolean) => void; close: () => void } => {
  const key = keyOf(kind, id);
  const holder = nextHolder++;
  let entry = opened.get(key);
  const fresh = entry === undefined;
  if (entry === undefined) {
    entry = {
      kind,
      id,
      holders: new Map(),
      lastSentAt: 0,
      sentEditing: null,
      trailing: null,
    };
    opened.set(key, entry);
  }
  const held = entry;
  held.holders.set(holder, false);
  if (fresh) sendNow(held);
  syncHeartbeat();
  let closed = false;
  return {
    setEditing: (editing: boolean) => {
      if (closed || held.holders.get(holder) === editing) return;
      held.holders.set(holder, editing);
      sendThrottled(held);
    },
    close: () => {
      if (closed) return;
      closed = true;
      held.holders.delete(holder);
      if (held.holders.size > 0) {
        sendThrottled(held);
        return;
      }
      cancelTrailing(held);
      opened.delete(key);
      transmit({ action: 'presence_leave', kind, id });
      syncHeartbeat();
      if (viewers.delete(key)) notify();
    },
  };
};

/** The other viewers of one entity right now, empty without a socket. */
export const presenceViewers = (
  kind: PresenceKind,
  id: string
): readonly PresenceViewer[] => viewers.get(keyOf(kind, id)) ?? EMPTY;

/** Hears every change of any viewer list. */
export const subscribePresence = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Reports the calling page as viewing one entity while mounted, editing when
 * `editing` is set, and answers the other people viewing it. A null id opens
 * nothing.
 */
export const usePresence = (
  kind: PresenceKind,
  id: string | null | undefined,
  editing = false
): readonly PresenceViewer[] => {
  const handle = useRef<ReturnType<typeof openPresence> | null>(null);
  useEffect(() => {
    if (!id) return undefined;
    const presence = openPresence(kind, id);
    handle.current = presence;
    return () => {
      handle.current = null;
      presence.close();
    };
  }, [kind, id]);
  useEffect(() => {
    handle.current?.setEditing(editing);
  }, [kind, id, editing]);
  return useSyncExternalStore(
    subscribePresence,
    () => (id ? presenceViewers(kind, id) : EMPTY),
    () => EMPTY
  );
};

/** Resets the store and lets a test drive the clock. */
export const resetPresenceForTests = (now?: () => number): void => {
  for (const entry of opened.values()) cancelTrailing(entry);
  opened.clear();
  viewers.clear();
  listeners.clear();
  transport = null;
  if (heartbeat !== null) clearInterval(heartbeat);
  heartbeat = null;
  clock = now ?? (() => Date.now());
};
