/**
 * The slug and key prefix rules, pinned against the regexes in the M1 API
 * contract. These are the shapes the server enforces, so a change here without a
 * contract change is a bug in the frontend rather than a loosened rule.
 */

import { describe, expect, it } from 'vitest';
import {
  estimateChoices,
  keyPrefixFromName,
  looksLikeIssueKey,
  slugFromName,
  validateBody,
  validateDateRange,
  validateEstimate,
  validateKeyPrefix,
  validateLabelColor,
  validateSlug,
  validateTitle,
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

describe('estimateChoices', () => {
  it('offers nothing when the team does not estimate', () => {
    expect(estimateChoices('off')).toEqual([]);
  });

  it('offers the fibonacci run the contract fixes', () => {
    expect(estimateChoices('fibonacci')).toEqual([
      '1',
      '2',
      '3',
      '5',
      '8',
      '13',
      '21',
    ]);
  });

  it('offers one to ten on the linear scale', () => {
    expect(estimateChoices('linear')).toHaveLength(10);
    expect(estimateChoices('linear').at(-1)).toBe('10');
  });

  it('offers the five shirt sizes', () => {
    expect(estimateChoices('tshirt')).toEqual(['XS', 'S', 'M', 'L', 'XL']);
  });
});

describe('validateEstimate', () => {
  it('accepts an unset estimate on every scale', () => {
    expect(validateEstimate('', 'off')).toBeNull();
    expect(validateEstimate('', 'fibonacci')).toBeNull();
  });

  it('refuses any value at all when the scale is off', () => {
    expect(validateEstimate('3', 'off')).toBe(
      'This team does not estimate issues.'
    );
  });

  it('accepts a value on the scale and refuses one off it', () => {
    expect(validateEstimate('8', 'fibonacci')).toBeNull();
    expect(validateEstimate('4', 'fibonacci')).toContain('Use one of');
    expect(validateEstimate('M', 'tshirt')).toBeNull();
    expect(validateEstimate('XXL', 'tshirt')).toContain('Use one of');
  });
});

describe('validateTitle', () => {
  it('passes a blank field so an untouched form shows no error', () => {
    expect(validateTitle('')).toBeNull();
  });

  it('passes a title at the ceiling and refuses one past it', () => {
    expect(validateTitle('a'.repeat(200))).toBeNull();
    expect(validateTitle('a'.repeat(201))).toBe('Use at most 200 characters.');
  });
});

describe('validateBody', () => {
  it('passes an empty body', () => {
    expect(validateBody('')).toBeNull();
  });

  it('counts bytes rather than characters, as the contract does', () => {
    expect(validateBody('a'.repeat(65536))).toBeNull();
    expect(validateBody('a'.repeat(65537))).toContain('too long');
    expect(validateBody('\u00e9'.repeat(32769))).toContain('too long');
  });
});

describe('validateDateRange', () => {
  it('passes an unset pair', () => {
    expect(validateDateRange('', '')).toBeNull();
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(validateDateRange('17-09-2026', '')).toBe(
      'Use a date such as 2026-09-17.'
    );
  });

  it('refuses a due date before its start date', () => {
    expect(validateDateRange('2026-09-17', '2026-09-16')).toBe(
      'The due date cannot fall before the start date.'
    );
  });

  it('accepts a due date on the start date', () => {
    expect(validateDateRange('2026-09-17', '2026-09-17')).toBeNull();
  });
});

describe('looksLikeIssueKey', () => {
  it('recognises a key in either case', () => {
    expect(looksLikeIssueKey('ENG-12')).toBe(true);
    expect(looksLikeIssueKey(' eng-12 ')).toBe(true);
  });

  it('does not take a title fragment for a key', () => {
    expect(looksLikeIssueKey('engine')).toBe(false);
    expect(looksLikeIssueKey('ENG-')).toBe(false);
  });
});
