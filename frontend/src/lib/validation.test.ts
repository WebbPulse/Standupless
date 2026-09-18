/**
 * The slug and key prefix rules, pinned against the regexes in the M1 API
 * contract. These are the shapes the server enforces, so a change here without a
 * contract change is a bug in the frontend rather than a loosened rule.
 */

import { describe, expect, it } from 'vitest';
import {
  keyPrefixFromName,
  slugFromName,
  validateKeyPrefix,
  validateLabelColor,
  validateSlug,
} from './validation';

describe('validateSlug', () => {
  it('accepts the shapes the contract allows', () => {
    for (const value of ['abc', 'my-team', 'a1-b2-c3', 'x'.repeat(40)]) {
      expect(validateSlug(value)).toBeNull();
    }
  });

  it('refuses anything shorter than three characters', () => {
    expect(validateSlug('ab')).not.toBeNull();
  });

  it('refuses anything longer than forty characters', () => {
    expect(validateSlug('x'.repeat(41))).not.toBeNull();
  });

  it('refuses uppercase, spaces and punctuation', () => {
    for (const value of ['MyTeam', 'my team', 'my_team', 'my.team']) {
      expect(validateSlug(value)).not.toBeNull();
    }
  });

  it('treats an untouched field as not yet an error', () => {
    expect(validateSlug('')).toBeNull();
  });
});

describe('validateKeyPrefix', () => {
  it('accepts the shapes the contract allows', () => {
    for (const value of ['EN', 'ENG', 'A1', 'ABCDEF']) {
      expect(validateKeyPrefix(value)).toBeNull();
    }
  });

  it('refuses a single character, since the contract needs at least two', () => {
    expect(validateKeyPrefix('E')).not.toBeNull();
  });

  it('refuses more than six characters', () => {
    expect(validateKeyPrefix('ABCDEFG')).not.toBeNull();
  });

  it('refuses a leading digit', () => {
    expect(validateKeyPrefix('1AB')).not.toBeNull();
  });

  it('refuses lowercase and punctuation', () => {
    for (const value of ['eng', 'Eng', 'EN-G']) {
      expect(validateKeyPrefix(value)).not.toBeNull();
    }
  });

  it('treats an untouched field as not yet an error', () => {
    expect(validateKeyPrefix('')).toBeNull();
  });
});

describe('validateLabelColor', () => {
  it('accepts a six digit hex colour', () => {
    expect(validateLabelColor('#3b82f6')).toBeNull();
  });

  it('refuses a short or malformed colour', () => {
    for (const value of ['#fff', '3b82f6', '#3b82f6ff']) {
      expect(validateLabelColor(value)).not.toBeNull();
    }
  });
});

describe('slugFromName', () => {
  it('lowercases and hyphenates a name into a valid slug', () => {
    expect(slugFromName('My Great Team')).toBe('my-great-team');
  });

  it('drops punctuation and collapses runs of separators', () => {
    expect(slugFromName('Acme, Inc.  Ops')).toBe('acme-inc-ops');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugFromName('  Hello  ')).toBe('hello');
  });

  it('caps the result at the forty character ceiling', () => {
    expect(slugFromName('x'.repeat(60))).toHaveLength(40);
  });
});

describe('keyPrefixFromName', () => {
  it('uppercases the alphanumerics of a name', () => {
    expect(keyPrefixFromName('Engine')).toBe('ENGINE');
  });

  it('drops spaces and punctuation', () => {
    expect(keyPrefixFromName('My Team!')).toBe('MYTEAM');
  });

  it('caps the result at the six character ceiling', () => {
    expect(keyPrefixFromName('Engineering')).toBe('ENGINE');
  });

  it('drops a leading digit, which the contract refuses', () => {
    expect(keyPrefixFromName('3M Ops')).toBe('MOPS');
  });
});
