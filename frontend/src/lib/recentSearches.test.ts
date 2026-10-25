/**
 * The recent search list: recording puts a search first once, the same term
 * under the same filters is one entry, the list holds at most ten, each
 * workspace keeps its own, removing and clearing drop entries, and unreadable
 * storage reads as an empty list while a refused write is ignored.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRecentSearches,
  forgetRecentSearch,
  readRecentSearches,
  RECENT_SEARCH_LIMIT,
  recentSearchesStorageKey,
  recordRecentSearch,
  type RecentSearch,
} from './recentSearches';

/** A search with no filters, unless some are given. */
const search = (q: string, over: Partial<RecentSearch> = {}): RecentSearch => ({
  q,
  team: '',
  type: '',
  status: '',
  ...over,
});

/** The terms of a workspace's list, newest first. */
const terms = (workspaceId = 'ws-1'): string[] =>
  readRecentSearches(workspaceId).map((row) => row.q);

beforeEach(() => {
  globalThis.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recording a recent search', () => {
  it('puts the newest search first', () => {
    recordRecentSearch('ws-1', search('cache'));
    recordRecentSearch('ws-1', search('token'));

    expect(terms()).toEqual(['token', 'cache']);
  });

  it('keeps the filters a search ran under', () => {
    recordRecentSearch(
      'ws-1',
      search('cache', { team: 'team-1', type: 'issues', status: 'started' })
    );

    expect(readRecentSearches('ws-1')).toEqual([
      { q: 'cache', team: 'team-1', type: 'issues', status: 'started' },
    ]);
  });

  it('moves a search run again to the front without a duplicate', () => {
    recordRecentSearch('ws-1', search('cache'));
    recordRecentSearch('ws-1', search('token'));
    recordRecentSearch('ws-1', search('  Cache '));

    expect(terms()).toEqual(['Cache', 'token']);
  });

  it('keeps the same term under different filters apart', () => {
    recordRecentSearch('ws-1', search('cache'));
    recordRecentSearch('ws-1', search('cache', { team: 'team-1' }));

    expect(readRecentSearches('ws-1')).toHaveLength(2);
  });

  it('holds at most the limit, dropping the oldest', () => {
    for (let number = 1; number <= RECENT_SEARCH_LIMIT + 2; number += 1) {
      recordRecentSearch('ws-1', search(`term ${number}`));
    }

    const held = terms();
    expect(RECENT_SEARCH_LIMIT).toBe(10);
    expect(held).toHaveLength(RECENT_SEARCH_LIMIT);
    expect(held[0]).toBe(`term ${RECENT_SEARCH_LIMIT + 2}`);
    expect(held).not.toContain('term 1');
    expect(held).not.toContain('term 2');
  });

  it('ignores a blank term', () => {
    recordRecentSearch('ws-1', search('   '));

    expect(terms()).toEqual([]);
  });

  it('keeps each workspace apart', () => {
    recordRecentSearch('ws-1', search('cache'));
    recordRecentSearch('ws-2', search('token'));

    expect(terms('ws-1')).toEqual(['cache']);
    expect(terms('ws-2')).toEqual(['token']);
  });

  it('remembers nothing without a workspace', () => {
    expect(recentSearchesStorageKey('')).toBeNull();
    expect(recordRecentSearch('', search('cache'))).toEqual([]);
    expect(globalThis.localStorage.length).toBe(0);
  });

  it('answers the list as it now stands', () => {
    recordRecentSearch('ws-1', search('cache'));

    expect(
      recordRecentSearch('ws-1', search('token')).map((row) => row.q)
    ).toEqual(['token', 'cache']);
  });
});

describe('removing recent searches', () => {
  it('drops one search and keeps the rest', () => {
    recordRecentSearch('ws-1', search('cache'));
    recordRecentSearch('ws-1', search('token'));

    const kept = forgetRecentSearch('ws-1', search('cache'));

    expect(kept.map((row) => row.q)).toEqual(['token']);
    expect(terms()).toEqual(['token']);
  });

  it('drops the storage entry once the list is empty', () => {
    recordRecentSearch('ws-1', search('cache'));
    forgetRecentSearch('ws-1', search('cache'));

    expect(
      globalThis.localStorage.getItem(recentSearchesStorageKey('ws-1') ?? '')
    ).toBeNull();
  });

  it('clears one workspace without touching another', () => {
    recordRecentSearch('ws-1', search('cache'));
    recordRecentSearch('ws-2', search('token'));

    clearRecentSearches('ws-1');

    expect(terms('ws-1')).toEqual([]);
    expect(terms('ws-2')).toEqual(['token']);
  });
});

describe('unreadable storage', () => {
  it('reads as empty and ignores writes when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => recordRecentSearch('ws-1', search('cache'))).not.toThrow();
    expect(() => forgetRecentSearch('ws-1', search('cache'))).not.toThrow();
    expect(() => {
      clearRecentSearches('ws-1');
    }).not.toThrow();
    expect(readRecentSearches('ws-1')).toEqual([]);
  });

  it('reads something that is not a list as empty', () => {
    globalThis.localStorage.setItem(
      recentSearchesStorageKey('ws-1') ?? '',
      '{"q":"cache"}'
    );

    expect(readRecentSearches('ws-1')).toEqual([]);
  });

  it('skips entries of the wrong shape', () => {
    globalThis.localStorage.setItem(
      recentSearchesStorageKey('ws-1') ?? '',
      JSON.stringify([
        { q: 'cache', team: '', type: '', status: '' },
        { q: 3 },
        'token',
        { q: '', team: '', type: '', status: '' },
      ])
    );

    expect(terms()).toEqual(['cache']);
  });

  it('reads malformed JSON as empty', () => {
    globalThis.localStorage.setItem(
      recentSearchesStorageKey('ws-1') ?? '',
      'not json'
    );

    expect(readRecentSearches('ws-1')).toEqual([]);
  });
});
