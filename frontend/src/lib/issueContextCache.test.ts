/**
 * The browser cache of issue view lists: a reload must find every team's
 * entry or none, and sign-out must leave nothing behind.
 */

import { describe, expect, it } from 'vitest';
import {
  clearIssueContextCache,
  readCachedPart,
  readCachedParts,
  writeCachedPart,
} from './issueContextCache';

describe('issueContextCache', () => {
  it('reads back what was written for a team', () => {
    writeCachedPart('ws', 'team-a', 'statuses', { teamId: 'team-a' });
    expect(readCachedPart('ws', 'team-a', 'statuses')).toEqual({
      teamId: 'team-a',
    });
    expect(readCachedPart('ws', 'team-a', 'lists')).toBeNull();
    expect(readCachedPart('other', 'team-a', 'statuses')).toBeNull();
  });

  it('answers for several teams only when each has an entry', () => {
    writeCachedPart('ws', 'team-a', 'statuses', { teamId: 'team-a' });
    expect(readCachedParts('ws', ['team-a', 'team-b'], 'statuses')).toBeNull();
    writeCachedPart('ws', 'team-b', 'statuses', { teamId: 'team-b' });
    expect(readCachedParts('ws', ['team-a', 'team-b'], 'statuses')).toEqual([
      { teamId: 'team-a' },
      { teamId: 'team-b' },
    ]);
    expect(readCachedParts('ws', [], 'statuses')).toBeNull();
  });

  it('ignores an unreadable entry', () => {
    globalThis.localStorage.setItem(
      'standupless.issueContext.v1.ws.team-a.statuses',
      '{not json'
    );
    expect(readCachedPart('ws', 'team-a', 'statuses')).toBeNull();
  });

  it('forgets every entry and nothing else on sign-out', () => {
    writeCachedPart('ws', 'team-a', 'statuses', { teamId: 'team-a' });
    writeCachedPart('ws', 'team-b', 'lists', { teamId: 'team-b' });
    globalThis.localStorage.setItem('standupless-last-workspace', 'ws');
    clearIssueContextCache();
    expect(readCachedPart('ws', 'team-a', 'statuses')).toBeNull();
    expect(readCachedPart('ws', 'team-b', 'lists')).toBeNull();
    expect(globalThis.localStorage.getItem('standupless-last-workspace')).toBe(
      'ws'
    );
  });
});
