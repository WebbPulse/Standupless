/**
 * The recent issue list: recording puts an issue first once, the list holds
 * at most eight, each workspace and viewer keeps its own, forgetting drops an
 * issue by id or key, and unreadable storage reads as an empty list.
 */

import { ApiError } from '@webbpulse/api-client';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetRecentIssue,
  isUnreadableIssue,
  readRecentIssues,
  RECENT_ISSUE_LIMIT,
  recentIssuesStorageKey,
  recordRecentIssue,
  useRecordRecentIssue,
  type RecentIssueSource,
} from './recentIssues';

/** An issue as a view hands it over, numbered so each is distinct. */
const issue = (number: number): RecentIssueSource => ({
  id: `id-${number}`,
  key: `ENG-${number}`,
  title: `Issue ${number}`,
  team_id: 'team-1',
  status_id: 'status-1',
});

/** The keys of a viewer's list in a workspace, newest first. */
const keys = (workspaceId = 'ws-1', viewerId = 'user-1'): string[] =>
  readRecentIssues(workspaceId, viewerId).map((row) => row.key);

/** A failed read answered with the given HTTP status. */
const failure = (status: number): ApiError =>
  new ApiError({
    status,
    statusText: 'Refused',
    body: { message: 'Refused' },
    url: '/api/workspaces/ws-1/issues/ENG-1',
    method: 'GET',
  });

beforeEach(() => {
  globalThis.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recording a recent issue', () => {
  it('puts the newest issue first', () => {
    recordRecentIssue('ws-1', 'user-1', issue(1));
    recordRecentIssue('ws-1', 'user-1', issue(2));

    expect(keys()).toEqual(['ENG-2', 'ENG-1']);
  });

  it('moves an issue opened again to the front without a duplicate', () => {
    recordRecentIssue('ws-1', 'user-1', issue(1));
    recordRecentIssue('ws-1', 'user-1', issue(2));
    recordRecentIssue('ws-1', 'user-1', { ...issue(1), title: 'Renamed' });

    expect(keys()).toEqual(['ENG-1', 'ENG-2']);
    expect(readRecentIssues('ws-1', 'user-1')[0]?.title).toBe('Renamed');
  });

  it('holds at most the limit, dropping the oldest', () => {
    for (let number = 1; number <= RECENT_ISSUE_LIMIT + 2; number += 1) {
      recordRecentIssue('ws-1', 'user-1', issue(number));
    }

    const held = keys();
    expect(held).toHaveLength(RECENT_ISSUE_LIMIT);
    expect(held[0]).toBe(`ENG-${RECENT_ISSUE_LIMIT + 2}`);
    expect(held).not.toContain('ENG-1');
    expect(held).not.toContain('ENG-2');
  });

  it('keeps each workspace and viewer apart', () => {
    recordRecentIssue('ws-1', 'user-1', issue(1));
    recordRecentIssue('ws-2', 'user-1', issue(2));
    recordRecentIssue('ws-1', 'user-2', issue(3));

    expect(keys('ws-1', 'user-1')).toEqual(['ENG-1']);
    expect(keys('ws-2', 'user-1')).toEqual(['ENG-2']);
    expect(keys('ws-1', 'user-2')).toEqual(['ENG-3']);
  });

  it('records nothing without a viewer', () => {
    recordRecentIssue('ws-1', undefined, issue(1));

    expect(recentIssuesStorageKey('ws-1', undefined)).toBeNull();
    expect(readRecentIssues('ws-1', undefined)).toEqual([]);
    expect(globalThis.localStorage.length).toBe(0);
  });
});

describe('reading the list', () => {
  it('reads unparseable storage as an empty list', () => {
    const storageKey = recentIssuesStorageKey('ws-1', 'user-1') ?? '';
    globalThis.localStorage.setItem(storageKey, '{not json');

    expect(readRecentIssues('ws-1', 'user-1')).toEqual([]);
  });

  it('skips rows of the wrong shape', () => {
    const storageKey = recentIssuesStorageKey('ws-1', 'user-1') ?? '';
    globalThis.localStorage.setItem(
      storageKey,
      JSON.stringify([{ id: 1 }, { ...issue(1) }])
    );

    expect(keys()).toEqual(['ENG-1']);
  });

  it('reads as empty and ignores writes when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => {
      recordRecentIssue('ws-1', 'user-1', issue(1));
    }).not.toThrow();
    expect(readRecentIssues('ws-1', 'user-1')).toEqual([]);
  });
});

describe('forgetting a recent issue', () => {
  it('drops an issue by its id or its key in any case', () => {
    recordRecentIssue('ws-1', 'user-1', issue(1));
    recordRecentIssue('ws-1', 'user-1', issue(2));
    recordRecentIssue('ws-1', 'user-1', issue(3));

    forgetRecentIssue('ws-1', 'user-1', 'id-1');
    forgetRecentIssue('ws-1', 'user-1', 'eng-3');

    expect(keys()).toEqual(['ENG-2']);
  });

  it('treats not found and forbidden as unreadable', () => {
    expect(isUnreadableIssue(failure(404))).toBe(true);
    expect(isUnreadableIssue(failure(403))).toBe(true);
    expect(isUnreadableIssue(failure(500))).toBe(false);
    expect(isUnreadableIssue(null)).toBe(false);
  });
});

describe('useRecordRecentIssue', () => {
  it('records the issue a view shows', () => {
    renderHook(() => {
      useRecordRecentIssue('ws-1', 'user-1', 'ENG-1', issue(1), null);
    });

    expect(keys()).toEqual(['ENG-1']);
  });

  it('forgets the issue a view could not read', () => {
    recordRecentIssue('ws-1', 'user-1', issue(1));
    recordRecentIssue('ws-1', 'user-1', issue(2));

    renderHook(() => {
      useRecordRecentIssue('ws-1', 'user-1', 'ENG-1', undefined, failure(404));
    });

    expect(keys()).toEqual(['ENG-2']);
  });

  it('keeps the issue when a read fails for another reason', () => {
    recordRecentIssue('ws-1', 'user-1', issue(1));

    renderHook(() => {
      useRecordRecentIssue('ws-1', 'user-1', 'ENG-1', undefined, failure(500));
    });

    expect(keys()).toEqual(['ENG-1']);
  });
});
