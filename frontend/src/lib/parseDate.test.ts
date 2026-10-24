import { describe, expect, it } from 'vitest';
import { isoDate } from './propertyOptions';
import { parseTypedDate } from './parseDate';

const WEDNESDAY = new Date(2026, 9, 21);

const read = (
  text: string,
  today: Date = WEDNESDAY,
  dayFirst = false
): string | null => {
  const day = parseTypedDate(text, today, { weekStart: 1, dayFirst });
  return day === null ? null : isoDate(day);
};

describe('parseTypedDate', () => {
  it.each([
    ['fri', '2026-10-23'],
    ['FRIDAY', '2026-10-23'],
    ['this fri', '2026-10-23'],
    ['sun', '2026-10-25'],
    ['wed', '2026-10-28'],
    ['next mon', '2026-10-26'],
    ['next fri', '2026-10-30'],
    ['next sun', '2026-11-01'],
  ])('reads the weekday %s', (text, expected) => {
    expect(read(text)).toBe(expected);
  });

  it.each([
    ['today', '2026-10-21'],
    ['Tomorrow', '2026-10-22'],
    ['in 3 days', '2026-10-24'],
    ['5 days', '2026-10-26'],
    ['in 2 weeks', '2026-11-04'],
    ['in a week', '2026-10-28'],
    ['in 1 month', '2026-11-21'],
    ['in 2 months', '2026-12-21'],
    ['3d', '2026-10-24'],
    ['2w', '2026-11-04'],
    ['1m', '2026-11-21'],
  ])('reads the relative day %s', (text, expected) => {
    expect(read(text)).toBe(expected);
  });

  it.each([
    ['nov 12', '2026-11-12'],
    ['12 nov', '2026-11-12'],
    ['November 12th', '2026-11-12'],
    ['nov 12, 2027', '2027-11-12'],
    ['11/12', '2026-11-12'],
    ['2026-11-12', '2026-11-12'],
    ['end of week', '2026-10-23'],
    ['end of month', '2026-10-31'],
    ['next quarter', '2027-01-01'],
  ])('reads the calendar day %s', (text, expected) => {
    expect(read(text)).toBe(expected);
  });

  it('reads a numeric day first in a day first locale', () => {
    expect(read('11/12', WEDNESDAY, true)).toBe('2026-12-11');
  });

  it.each([
    ['oct 1', '2027-10-01'],
    ['1 oct', '2027-10-01'],
    ['1/15', '2027-01-15'],
    ['oct 21', '2026-10-21'],
  ])('rolls the past day %s to next year', (text, expected) => {
    expect(read(text)).toBe(expected);
  });

  it.each([
    ['tomorrow', new Date(2026, 0, 31), '2026-02-01'],
    ['in 1 month', new Date(2026, 0, 31), '2026-02-28'],
    ['end of month', new Date(2026, 1, 3), '2026-02-28'],
    ['in 3 days', new Date(2026, 9, 30), '2026-11-02'],
    ['mon', new Date(2026, 11, 31), '2027-01-04'],
  ])('crosses a month boundary for %s', (text, today, expected) => {
    expect(read(text, today)).toBe(expected);
  });

  it.each([
    [''],
    ['banana'],
    ['next banana'],
    ['feb 30'],
    ['2026-02-30'],
    ['13/45'],
    ['12 m'],
    ['a week'],
  ])('refuses %j', (text) => {
    expect(read(text)).toBeNull();
  });
});
