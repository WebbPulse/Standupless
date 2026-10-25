/**
 * The device copy of the workspace's reads stores only list and sidebar keys,
 * keeps one workspace at a time, and is deleted on sign out.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPolledQueryCache,
  createMemoryQueryCacheStore,
  type QueryCacheStore,
} from '@webbpulse/api-client/react';
import {
  PERSISTED_NAMESPACES_STORAGE_KEY,
  clearQueryPersistence,
  persistedNamespace,
  persistedQueryPrefixes,
  readPersistedNamespaces,
  rememberWorkspaceId,
  rememberedWorkspaceId,
  startQueryPersistence,
} from './queryPersistence';

/** A stored record under one key. */
const record = (key: string) => ({
  key,
  data: { ok: true },
  etag: undefined,
  fetchedAt: Date.now(),
  version: 1,
});

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

  it('lists only workspace scoped list and sidebar keys', () => {
    const heads = persistedQueryPrefixes('ws-1').map((prefix): unknown =>
      typeof prefix === 'string' ? prefix : prefix[0]
    );
    expect(heads).toContain('issue-collection');
    expect(heads).toContain('favorites');
    expect(heads).not.toContain('current-user');
    expect(heads).not.toContain('api-keys');
    expect(heads).not.toContain('members');
    for (const prefix of persistedQueryPrefixes('ws-1')) {
      if (typeof prefix !== 'string' && prefix.length > 1) {
        expect(prefix[1]).toBe('ws-1');
      }
    }
  });

  it('scopes the namespace to the person and the workspace', () => {
    expect(persistedNamespace('u-1', 'ws-1')).not.toBe(
      persistedNamespace('u-2', 'ws-1')
    );
    expect(persistedNamespace('u-1', 'ws-1')).not.toBe(
      persistedNamespace('u-1', 'ws-2')
    );
  });

  it('deletes the previous workspace when another opens', async () => {
    const first = persistedNamespace('u-1', 'ws-1');
    await store.save(first, [record('a')]);
    startQueryPersistence('u-1', 'ws-1', store);
    expect(readPersistedNamespaces()).toEqual([first]);

    startQueryPersistence('u-1', 'ws-2', store);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(store.load(first)).resolves.toEqual([]);
    expect(readPersistedNamespaces()).toEqual([
      persistedNamespace('u-1', 'ws-2'),
    ]);
  });

  it('deletes every namespace on sign out', async () => {
    const stale = persistedNamespace('u-9', 'ws-9');
    await store.save(stale, [record('b')]);
    globalThis.localStorage.setItem(
      PERSISTED_NAMESPACES_STORAGE_KEY,
      JSON.stringify([stale])
    );
    rememberWorkspaceId('acme', 'ws-1');

    await clearQueryPersistence(store);

    await expect(store.load(stale)).resolves.toEqual([]);
    expect(readPersistedNamespaces()).toEqual([]);
    expect(rememberedWorkspaceId('acme')).toBeNull();
  });

  it('remembers the workspace id a slug resolved to', () => {
    expect(rememberedWorkspaceId('acme')).toBeNull();
    rememberWorkspaceId('acme', 'ws-1');
    expect(rememberedWorkspaceId('acme')).toBe('ws-1');
  });
});
