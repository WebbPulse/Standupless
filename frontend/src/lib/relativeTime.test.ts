import { describe, expect, it } from 'vitest';
import { compactAge, fullTimestamp, relativeTime } from './relativeTime';

const now = new Date('2026-09-25T12:00:00');

describe('relativeTime', () => {
  it('reads under a minute as just now', () => {
    expect(relativeTime('2026-09-25T11:59:30', now)).toBe('just now');
  });

  it('reads minutes, hours and days', () => {
    expect(relativeTime('2026-09-25T11:55:00', now)).toBe('5m ago');
    expect(relativeTime('2026-09-25T09:00:00', now)).toBe('3h ago');
    expect(relativeTime('2026-09-22T12:00:00', now)).toBe('3d ago');
  });

  it('reads a week or more as a date, with the year only when it differs', () => {
    expect(relativeTime('2026-09-01T12:00:00', now)).toBe('Sep 1');
    expect(relativeTime('2025-12-31T12:00:00', now)).toBe('Dec 31, 2025');
  });

  it('never reads a future time as negative', () => {
    expect(relativeTime('2026-09-25T12:05:00', now)).toBe('just now');
  });

  it('returns a value that does not parse as it came', () => {
    expect(relativeTime('nonsense', now)).toBe('nonsense');
    expect(fullTimestamp('nonsense')).toBe('nonsense');
  });
});

describe('compactAge', () => {
  it('reads the distance in the fewest characters', () => {
    expect(compactAge('2026-09-25T11:59:30', now)).toBe('now');
    expect(compactAge('2026-09-25T11:55:00', now)).toBe('5m');
    expect(compactAge('2026-09-25T09:00:00', now)).toBe('3h');
    expect(compactAge('2026-08-31T12:00:00', now)).toBe('25d');
    expect(compactAge('2026-05-25T12:00:00', now)).toBe('4mo');
    expect(compactAge('2024-09-01T12:00:00', now)).toBe('2y');
  });

  it('never reads a future time as negative, and keeps a bad value', () => {
    expect(compactAge('2026-09-25T12:05:00', now)).toBe('now');
    expect(compactAge('nonsense', now)).toBe('nonsense');
  });
});
