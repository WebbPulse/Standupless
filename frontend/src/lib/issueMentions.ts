/**
 * The read behind every issue chip in a description, comment, document or
 * project overview. Each chip asks for its own key, but the asks made in the
 * same moment are gathered into one batch lookup per workspace, so a body that
 * mentions twenty issues costs one request rather than twenty, and its chips
 * keep polling together because they settle together.
 */

import { lookupIssuesByKey } from '../api/issues';
import type { IssueRead } from '../types/Api';

/** How long asks are gathered before the batch goes out. */
export const MENTION_BATCH_MS = 10;

/** How many keys one lookup may name, as the route allows. */
export const MAX_LOOKUP_KEYS = 100;

/** One key waiting on the next batch, with everyone who asked for it. */
interface PendingKey {
  resolvers: ((issue: IssueRead | null) => void)[];
  rejecters: ((reason: unknown) => void)[];
}

/** The keys one workspace is gathering, and the timer that sends them. */
interface PendingBatch {
  keys: Map<string, PendingKey>;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingBatch>();

/** The lookup a batch goes out through when a test replaces the real one. */
let replacement: typeof lookupIssuesByKey | null = null;

/** Replaces the lookup, for tests; returns a function restoring the real one. */
export const setMentionLookup = (
  next: typeof lookupIssuesByKey
): (() => void) => {
  replacement = next;
  return () => {
    replacement = null;
  };
};

/** Sends one chunk of gathered keys and settles everyone who asked for them. */
const sendChunk = async (
  workspaceId: string,
  chunk: [string, PendingKey][]
): Promise<void> => {
  try {
    const lookup = replacement ?? lookupIssuesByKey;
    const answer = await lookup(
      workspaceId,
      chunk.map(([key]) => key)
    );
    const byId = new Map(answer.issues.map((issue) => [issue.id, issue]));
    for (const [key, waiting] of chunk) {
      const id = answer.resolved[key];
      const issue = id === undefined ? null : (byId.get(id) ?? null);
      for (const resolve of waiting.resolvers) resolve(issue);
    }
  } catch (reason) {
    for (const [, waiting] of chunk) {
      for (const reject of waiting.rejecters) reject(reason);
    }
  }
};

/** Sends what a workspace gathered, in chunks the route accepts. */
const flush = (workspaceId: string): void => {
  const batch = pending.get(workspaceId);
  if (batch === undefined) return;
  pending.delete(workspaceId);
  const entries = [...batch.keys.entries()];
  for (let start = 0; start < entries.length; start += MAX_LOOKUP_KEYS) {
    void sendChunk(workspaceId, entries.slice(start, start + MAX_LOOKUP_KEYS));
  }
};

/**
 * The issue `key` names in the workspace, or null when it names nothing the
 * reader can see. Asks made within {@link MENTION_BATCH_MS} of each other go
 * out as one lookup, and a key asked for twice is sent once.
 */
export const loadIssueMention = (
  workspaceId: string,
  key: string
): Promise<IssueRead | null> =>
  new Promise((resolve, reject) => {
    const normalized = key.trim().toUpperCase();
    let batch = pending.get(workspaceId);
    if (batch === undefined) {
      batch = {
        keys: new Map(),
        timer: setTimeout(() => {
          flush(workspaceId);
        }, MENTION_BATCH_MS),
      };
      pending.set(workspaceId, batch);
    }
    const waiting = batch.keys.get(normalized) ?? {
      resolvers: [],
      rejecters: [],
    };
    waiting.resolvers.push(resolve);
    waiting.rejecters.push(reject);
    batch.keys.set(normalized, waiting);
  });
