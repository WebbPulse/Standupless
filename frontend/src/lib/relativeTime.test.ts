import { describe, expect, it } from 'vitest';
import {
  compactAge,
  dayHeading,
  fullTimestamp,
  localDay,
  relativeTime,
} from './relativeTime';

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

describe('dayHeading', () => {
  it('reads the current and previous local day by name', () => {
    expect(dayHeading('2026-09-25T08:00:00', now)).toBe('Today');
    expect(dayHeading('2026-09-24T23:30:00', now)).toBe('Yesterday');
  });

  it('reads older days as the weekday and date, with the year only when it differs', () => {
    expect(dayHeading('2026-09-21T12:00:00', now)).toBe('Mon, Sep 21');
    expect(dayHeading('2025-12-31T12:00:00', now)).toBe('Wed, Dec 31, 2025');
  });

  it('returns a malformed value as it came', () => {
    expect(dayHeading('soon', now)).toBe('soon');
  });
});

describe('localDay', () => {
  it('reads the local calendar day', () => {
    expect(localDay('2026-09-25T08:00:00')).toBe('2026-09-25');
  });
});
