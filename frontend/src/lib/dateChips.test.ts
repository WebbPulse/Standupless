/**
 * Holds date chips to their stored form, how they read, and which text after
 * an `@` the mention menu reads as a day.
 */

import { describe, expect, it } from 'vitest';
import {
  dateChipLabel,
  dateChipTitle,
  dateMentionOptions,
  dateMentionQuery,
  dateToken,
  isChipDate,
  leadingDateToken,
  monthGrid,
  weekdayNames,
} from './dateChips';
import { isoDate } from './propertyOptions';

const TODAY = new Date(2026, 9, 25, 12);

describe('the stored form', () => {
  it('writes and reads back only a real day', () => {
    expect(dateToken('2026-10-01')).toBe('<2026-10-01>');
    expect(isChipDate('2026-10-01')).toBe(true);
    expect(isChipDate('2026-02-30')).toBe(false);
    expect(isChipDate('2026-13-01')).toBe(false);
    expect(leadingDateToken('<2026-10-01> rest')).toEqual({
      value: '2026-10-01',
      length: 12,
    });
    expect(leadingDateToken('<2026-02-30>')).toBeNull();
    expect(leadingDateToken('x <2026-10-01>')).toBeNull();
  });
});

describe('dateChipLabel', () => {
  it('reads relative when the day is close', () => {
    expect(dateChipLabel('2026-10-24', TODAY)).toBe('Yesterday');
    expect(dateChipLabel('2026-10-25', TODAY)).toBe('Today');
    expect(dateChipLabel('2026-10-26', TODAY)).toBe('Tomorrow');
  });

  it('shows the year only when it is not this year', () => {
    expect(dateChipLabel('2026-11-12', TODAY)).not.toContain('2026');
    expect(dateChipLabel('2027-01-05', TODAY)).toContain('2027');
  });

  it('puts the full date in the tooltip', () => {
    expect(dateChipTitle('2026-10-01')).toContain('2026');
    expect(dateChipTitle('nope')).toBe('nope');
  });
});

describe('dateMentionQuery', () => {
  it('reads the text after an @ that starts a word', () => {
    expect(dateMentionQuery('Due @next friday')).toEqual({
      start: 4,
      query: 'next friday',
    });
    expect(dateMentionQuery('@Oct 1')).toEqual({ start: 0, query: 'Oct 1' });
  });

  it('stays shut after a space, inside an email or with no query', () => {
    expect(dateMentionQuery('@today ')).toBeNull();
    expect(dateMentionQuery('mail a@today')).toBeNull();
    expect(dateMentionQuery('@')).toBeNull();
  });
});

describe('dateMentionOptions', () => {
  it('reads each supported spelling as one day', () => {
    const value = (query: string): string | undefined =>
      dateMentionOptions(query, TODAY, 1)[0]?.value;
    expect(value('today')).toBe('2026-10-25');
    expect(value('tomorrow')).toBe('2026-10-26');
    expect(value('2026-10-01')).toBe('2026-10-01');
    expect(value('Nov 12')).toBe('2026-11-12');
    expect(value('12 Nov')).toBe('2026-11-12');
    expect(value('next friday')).toBeDefined();
  });

  it('offers nothing for text that is not a day', () => {
    expect(dateMentionOptions('tyler', TODAY, 1)).toEqual([]);
  });
});

describe('monthGrid', () => {
  it('pads the month to whole weeks from the week start', () => {
    const october = new Date(2026, 9, 1);
    const monday = monthGrid(october, 1);
    expect(monday.length % 7).toBe(0);
    expect(monday[0]?.getDay()).toBe(1);
    expect(monday.map(isoDate)).toContain('2026-10-31');
    const sunday = monthGrid(october, 0);
    expect(sunday[0]?.getDay()).toBe(0);
    expect(weekdayNames(1).map((weekday) => weekday.day)).toEqual([
      1, 2, 3, 4, 5, 6, 0,
    ]);
  });
});
