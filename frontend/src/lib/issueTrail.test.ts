/**
 * The remembered list behind the issue page's next and previous keys: it
 * round-trips through session storage, survives storage failing, ignores a
 * malformed entry, and places an issue by key without regard to case.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTrail,
  ISSUE_TRAIL_STORAGE_KEY,
  readTrail,
  rememberTrail,
  trailPosition,
  type IssueTrail,
} from './issueTrail';

const trail: IssueTrail = {
  slug: 'mine',
  keys: ['ENG-3', 'ENG-1', 'ENG-2'],
  from: '/w/mine/team/ENG',
};

beforeEach(() => {
  clearTrail();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rememberTrail and readTrail', () => {
  it('reads back what was remembered', () => {
    rememberTrail(trail);

    expect(readTrail()).toEqual(trail);
    expect(sessionStorage.getItem(ISSUE_TRAIL_STORAGE_KEY)).not.toBeNull();
  });

  it('holds the trail in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    rememberTrail(trail);

    expect(readTrail()).toEqual(trail);
  });

  it('ignores a stored value that is not a trail', () => {
    sessionStorage.setItem(ISSUE_TRAIL_STORAGE_KEY, '{"slug":1}');

    expect(readTrail()).toBeNull();
  });

  it('forgets the trail on clear', () => {
    rememberTrail(trail);
    clearTrail();

    expect(readTrail()).toBeNull();
  });
});

describe('trailPosition', () => {
  it('places an issue with its neighbours', () => {
    expect(trailPosition(trail, 'mine', 'ENG-1')).toEqual({
      index: 1,
      total: 3,
      previous: 'ENG-3',
      next: 'ENG-2',
      from: '/w/mine/team/ENG',
    });
  });

  it('has no previous at the start and no next at the end', () => {
    expect(trailPosition(trail, 'mine', 'ENG-3')?.previous).toBeNull();
    expect(trailPosition(trail, 'mine', 'ENG-2')?.next).toBeNull();
  });

  it('matches a key typed in lower case', () => {
    expect(trailPosition(trail, 'mine', 'eng-2')?.index).toBe(2);
  });

  it('is null for another workspace, a missing issue or no trail', () => {
    expect(trailPosition(trail, 'theirs', 'ENG-1')).toBeNull();
    expect(trailPosition(trail, 'mine', 'ENG-9')).toBeNull();
    expect(trailPosition(null, 'mine', 'ENG-1')).toBeNull();
  });
});
