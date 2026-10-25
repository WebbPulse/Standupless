/**
 * The device copy of the workspace's reads stores only the listed keys, never
 * the admin member directory, keeps the most recently opened issues, keeps one
 * workspace at a time, and is deleted on sign out.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPolledQueryCache,
  createMemoryQueryCacheStore,
  serializeQueryKey,
  type QueryCacheStore,
} from '@webbpulse/api-client/react';
import { issueKey, memberDirectoryKey, membersKey } from './queryKeys';
import {
  PERSISTED_ISSUE_LIMIT,
  clearQueryPersistence,
  persistedNamespace,
  persistedQueryExclusions,
  persistedQueryPrefixes,
  recordOpenedIssue,
  rememberWorkspaceId,
  rememberedWorkspaceId,
  startQueryPersistence,
} from './queryPersistence';

/** A stored record under one key. */
const record = (key: string, fetchedAt = Date.now()) => ({
  key,
  data: { ok: true },
  etag: undefined,
  fetchedAt,
  version: 1,
});

/** The stored key of one issue in workspace ws-1. */
const issue = (ref: string): string => serializeQueryKey(issueKey('ws-1', ref));

/** Lets queued promise callbacks run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('queryPersistence', () => {
  let store: QueryCacheStore;

  beforeEach(() => {
    globalThis.localStorage.clear();
    store = createMemoryQueryCacheStore();
  });

  afterEach(async () => {
    await clearQueryPersistence(store);
    clearPolledQueryCache();
    globalThis.localStorage.clear();
  });

  it('lists workspace scoped keys and no auth or settings keys', () => {
    const heads = persistedQueryPrefixes('ws-1').map((prefix): unknown =>
      typeof prefix === 'string' ? prefix : prefix[0]
    );
    expect(heads).toContain('issue-collection');
    expect(heads).toContain('issue');
    expect(heads).toContain('members');
    expect(heads).toContain('statuses');
    expect(heads).toContain('labels');
    expect(heads).toContain('favorites');
    expect(heads).not.toContain('current-user');
    expect(heads).not.toContain('api-keys');
    for (const prefix of persistedQueryPrefixes('ws-1')) {
      if (typeof prefix !== 'string' && prefix.length > 1) {
        expect(prefix[1]).toBe('ws-1');
      }
    }
  });

  it('stores the members but never the admin directory', () => {
    expect(persistedQueryPrefixes('ws-1')).toContainEqual(membersKey('ws-1'));
    expect(persistedQueryExclusions('ws-1')).toEqual([
      memberDirectoryKey('ws-1'),
    ]);
  });

  it('scopes the namespace to the person and the workspace', () => {
    expect(persistedNamespace('u-1', 'ws-1')).not.toBe(
      persistedNamespace('u-2', 'ws-1')
    );
    expect(persistedNamespace('u-1', 'ws-1')).not.toBe(
      persistedNamespace('u-1', 'ws-2')
    );
  });

  it('keeps only the most recently opened issues', async () => {
    const namespace = persistedNamespace('u-1', 'ws-1');
    const total = PERSISTED_ISSUE_LIMIT + 2;
    await store.save(
      namespace,
      Array.from({ length: total }, (_, index) =>
        record(issue(`i-${String(index)}`), Date.now() - (total - index))
      )
    );

    await startQueryPersistence('u-1', 'ws-1', store)?.ready;
    const kept = (await store.load(namespace)).map((held) => held.key);
    expect(kept).toHaveLength(PERSISTED_ISSUE_LIMIT);
    expect(kept).not.toContain(issue('i-0'));
    expect(kept).not.toContain(issue('i-1'));

    recordOpenedIssue('ws-1', 'i-new');
    await settle();
    const after = (await store.load(namespace)).map((held) => held.key);
    expect(after).not.toContain(issue('i-2'));
    expect(after).toContain(issue('i-3'));
  });

  it('deletes the previous workspace when another opens', async () => {
    const first = persistedNamespace('u-1', 'ws-1');
    const second = persistedNamespace('u-1', 'ws-2');
    await store.save(first, [record(issue('i-1'))]);
    startQueryPersistence('u-1', 'ws-1', store);
    await settle();
    await expect(store.load(first)).resolves.toHaveLength(1);

    await store.save(second, [
      record(serializeQueryKey(issueKey('ws-2', 'i-2'))),
    ]);
    startQueryPersistence('u-1', 'ws-2', store);
    await settle();
    await expect(store.load(first)).resolves.toEqual([]);
    await expect(store.listNamespaces?.()).resolves.toEqual([second]);
  });

  it('deletes every namespace on sign out', async () => {
    const stale = persistedNamespace('u-9', 'ws-9');
    await store.save(stale, [record('b')]);
    globalThis.localStorage.setItem(
      'standupless.queryCache.v1.namespaces',
      JSON.stringify([stale])
    );
    rememberWorkspaceId('acme', 'ws-1');

    await clearQueryPersistence(store);

    await expect(store.load(stale)).resolves.toEqual([]);
    expect(
      globalThis.localStorage.getItem('standupless.queryCache.v1.namespaces')
    ).toBeNull();
    expect(rememberedWorkspaceId('acme')).toBeNull();
  });

  it('remembers the workspace id a slug resolved to', () => {
    expect(rememberedWorkspaceId('acme')).toBeNull();
    rememberWorkspaceId('acme', 'ws-1');
    expect(rememberedWorkspaceId('acme')).toBe('ws-1');
  });
});
