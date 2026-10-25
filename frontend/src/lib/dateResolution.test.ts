/**
 * Coarse planning dates: the period edges a pick is stored at, the labels a
 * coarse date reads as, and the periods each picker tab offers.
 */

import { describe, expect, it } from 'vitest';
import {
  periodChoices,
  periodEnd,
  periodStart,
  planningDateLabel,
  snapDate,
} from './dateResolution';
import { timelineDate } from './timeline';

describe('period edges', () => {
  it.each([
    ['2026-11-15', 'month', '2026-11-01', '2026-11-30'],
    ['2028-02-10', 'month', '2028-02-01', '2028-02-29'],
    ['2026-08-04', 'quarter', '2026-07-01', '2026-09-30'],
    ['2026-12-31', 'quarter', '2026-10-01', '2026-12-31'],
    ['2027-05-20', 'half', '2027-01-01', '2027-06-30'],
    ['2027-07-01', 'half', '2027-07-01', '2027-12-31'],
    ['2027-03-03', 'year', '2027-01-01', '2027-12-31'],
    ['2026-11-15', 'day', '2026-11-15', '2026-11-15'],
  ] as const)(
    '%s at %s runs from %s to %s',
    (value, resolution, start, end) => {
      expect(periodStart(value, resolution)).toBe(start);
      expect(periodEnd(value, resolution)).toBe(end);
      expect(snapDate(value, resolution, 'start')).toBe(start);
      expect(snapDate(value, resolution, 'end')).toBe(end);
    }
  );
});

describe('planningDateLabel', () => {
  const today = new Date(2026, 9, 25);

  it.each([
    ['2026-11-30', 'month', 'Nov 2026'],
    ['2027-03-31', 'quarter', 'Q1 2027'],
    ['2027-12-31', 'half', 'H2 2027'],
    ['2027-12-31', 'year', '2027'],
  ] as const)('%s at %s reads %s', (value, resolution, label) => {
    expect(planningDateLabel(value, resolution, today)).toBe(label);
    expect(timelineDate(value, resolution)).toBe(label);
  });

  it('reads an exact day the way every other date does', () => {
    const label = planningDateLabel('2026-11-15', 'day', today);
    expect(label).toBe(planningDateLabel('2026-11-15', null, today));
    expect(label).not.toBe('Nov 2026');
    expect(timelineDate('2026-11-15', null)).toBe('2026-11-15');
  });
});

describe('periodChoices', () => {
  it('offers a year of quarters stored at their last day for a target', () => {
    expect(periodChoices(2027, 'quarter', 'end')).toEqual([
      { label: 'Q1', name: 'Q1 2027', value: '2027-03-31' },
      { label: 'Q2', name: 'Q2 2027', value: '2027-06-30' },
      { label: 'Q3', name: 'Q3 2027', value: '2027-09-30' },
      { label: 'Q4', name: 'Q4 2027', value: '2027-12-31' },
    ]);
  });

  it('offers twelve months, two halves and six years', () => {
    expect(periodChoices(2026, 'month', 'start')).toHaveLength(12);
    expect(periodChoices(2026, 'month', 'start')[10]).toEqual({
      label: 'Nov',
      name: 'Nov 2026',
      value: '2026-11-01',
    });
    expect(
      periodChoices(2026, 'half', 'end').map((choice) => choice.value)
    ).toEqual(['2026-06-30', '2026-12-31']);
    expect(
      periodChoices(2026, 'year', 'end').map((choice) => choice.label)
    ).toEqual(['2026', '2027', '2028', '2029', '2030', '2031']);
  });
});
