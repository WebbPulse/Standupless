import { describe, expect, it } from 'vitest';
import {
  compactDuration,
  durationWords,
  enteredStatusAt,
  timeInStatusSentence,
} from './timeInStatus';

const now = new Date('2026-10-25T12:00:00Z');

describe('compactDuration', () => {
  it('reads minutes, hours and days up to two weeks', () => {
    expect(compactDuration('2026-10-25T11:59:40Z', now)).toBe('now');
    expect(compactDuration('2026-10-25T11:55:00Z', now)).toBe('5m');
    expect(compactDuration('2026-10-25T09:00:00Z', now)).toBe('3h');
    expect(compactDuration('2026-10-22T12:00:00Z', now)).toBe('3d');
    expect(compactDuration('2026-10-12T12:00:00Z', now)).toBe('13d');
  });

  it('reads weeks to three months, then months and years', () => {
    expect(compactDuration('2026-09-20T12:00:00Z', now)).toBe('5w');
    expect(compactDuration('2026-06-01T12:00:00Z', now)).toBe('4mo');
    expect(compactDuration('2024-10-01T12:00:00Z', now)).toBe('2y');
  });

  it('returns a value that does not parse as it came', () => {
    expect(compactDuration('soon', now)).toBe('soon');
  });
});

describe('durationWords', () => {
  it('pluralises the unit', () => {
    expect(durationWords('2026-10-25T11:59:40Z', now)).toBe(
      'less than a minute'
    );
    expect(durationWords('2026-10-25T11:00:00Z', now)).toBe('1 hour');
    expect(durationWords('2026-10-22T12:00:00Z', now)).toBe('3 days');
  });
});

describe('timeInStatusSentence', () => {
  it('reads the stamp, falling back to creation without one', () => {
    const stamped = {
      created_at: '2026-09-01T12:00:00Z',
      status_changed_at: '2026-10-22T12:00:00Z',
    };
    expect(timeInStatusSentence('Todo', stamped, now)).toBe(
      'In Todo for 3 days'
    );
    expect(enteredStatusAt({ created_at: '2026-09-01T12:00:00Z' })).toBe(
      '2026-09-01T12:00:00Z'
    );
  });
});
