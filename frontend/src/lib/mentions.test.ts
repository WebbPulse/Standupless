import { describe, expect, it } from 'vitest';
import {
  insertMention,
  matchPeople,
  mentionHandle,
  mentionQuery,
} from './mentions';

const people = [
  { user_id: 'u-1', email: 'tyler@example.com', display_name: 'Tyler Webb' },
  { user_id: 'u-2', email: 'sam.lee@example.com', display_name: 'Sam Lee' },
];

describe('mentionQuery', () => {
  it('finds the mention the caret sits in', () => {
    expect(mentionQuery('hey @ty', 7)).toEqual({ start: 4, query: 'ty' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('ignores an email address being typed', () => {
    expect(mentionQuery('mail a@b', 8)).toBeNull();
  });

  it('closes once a space follows the handle', () => {
    expect(mentionQuery('@tyler ', 7)).toBeNull();
  });
});

describe('matchPeople', () => {
  it('ranks a prefix match first', () => {
    expect(matchPeople(people, 'sam').map((row) => row.user_id)).toEqual([
      'u-2',
    ]);
    expect(matchPeople(people, 'webb').map((row) => row.user_id)).toEqual([
      'u-1',
    ]);
  });

  it('offers everyone for an empty query', () => {
    expect(matchPeople(people, '')).toHaveLength(2);
  });
});

describe('insertMention', () => {
  it('replaces the partial handle with the local part and a space', () => {
    const query = mentionQuery('hi @sa there', 6);
    expect(query).not.toBeNull();
    if (query === null) return;
    const person = people[1];
    if (person === undefined) return;
    expect(insertMention('hi @sa there', query, person)).toEqual({
      text: 'hi @SamLee  there',
      caret: 11,
    });
    expect(mentionHandle(person)).toBe('SamLee');
  });
});
