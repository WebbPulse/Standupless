/**
 * The SLA helpers: the live status matching the server's rule, the two unit
 * countdown, the badge label, and how hours read in the settings select.
 */

import { describe, expect, it } from 'vitest';
import {
  formatSlaDuration,
  liveSlaStatus,
  slaHoursLabel,
  slaLabel,
  slaStatusAt,
} from './sla';

const now = new Date('2026-10-07T12:00:00Z');

describe('slaStatusAt', () => {
  it('reads a missing deadline as no SLA', () => {
    expect(slaStatusAt('2026-10-07T00:00:00Z', null, now)).toBe('none');
    expect(slaStatusAt(null, undefined, now)).toBe('none');
  });

  it('breaches once the deadline is reached', () => {
    expect(
      slaStatusAt('2026-10-06T12:00:00Z', '2026-10-07T12:00:00Z', now)
    ).toBe('breached');
  });

  it('is at risk inside a quarter of a short window', () => {
    const started = '2026-10-07T04:00:00Z';
    expect(slaStatusAt(started, '2026-10-07T13:00:00Z', now)).toBe('at_risk');
    expect(slaStatusAt(started, '2026-10-07T20:00:00Z', now)).toBe('on_track');
  });

  it('caps the at risk window at a day for a long SLA', () => {
    const started = '2026-09-23T12:00:00Z';
    expect(slaStatusAt(started, '2026-10-08T11:00:00Z', now)).toBe('at_risk');
    expect(slaStatusAt(started, '2026-10-08T13:00:00Z', now)).toBe('on_track');
  });

  it('lets the server say an issue has left its SLA', () => {
    expect(
      liveSlaStatus(
        {
          sla_started_at: '2026-10-06T12:00:00Z',
          sla_breaches_at: '2026-10-07T00:00:00Z',
          sla_status: 'none',
        },
        now
      )
    ).toBe('none');
  });

  it('recomputes a status the server read before it changed', () => {
    expect(
      liveSlaStatus(
        {
          sla_started_at: '2026-10-06T12:00:00Z',
          sla_breaches_at: '2026-10-07T11:00:00Z',
          sla_status: 'at_risk',
        },
        now
      )
    ).toBe('breached');
  });
});

describe('formatSlaDuration', () => {
  it('keeps the two largest units and drops zeros', () => {
    const minute = 60000;
    const hour = 60 * minute;
    const day = 24 * hour;
    expect(formatSlaDuration(2 * day + 4 * hour + 10 * minute)).toBe('2d 4h');
    expect(formatSlaDuration(5 * hour + 12 * minute)).toBe('5h 12m');
    expect(formatSlaDuration(3 * day + 20 * minute)).toBe('3d');
    expect(formatSlaDuration(45 * minute)).toBe('45m');
    expect(formatSlaDuration(10000)).toBe('1m');
  });
});

describe('slaLabel', () => {
  it('counts down before the deadline and up after it', () => {
    expect(
      slaLabel(
        {
          sla_started_at: '2026-10-07T00:00:00Z',
          sla_breaches_at: '2026-10-09T16:00:00Z',
          sla_status: 'on_track',
        },
        now
      )
    ).toBe('Breaches in 2d 4h');
    expect(
      slaLabel(
        {
          sla_started_at: '2026-10-06T00:00:00Z',
          sla_breaches_at: '2026-10-07T09:00:00Z',
          sla_status: 'breached',
        },
        now
      )
    ).toBe('Breached 3h ago');
    expect(
      slaLabel({ sla_started_at: null, sla_breaches_at: null }, now)
    ).toBeNull();
  });
});

describe('slaHoursLabel', () => {
  it('reads hours, days and weeks, and a value off the list', () => {
    expect(slaHoursLabel(null)).toBe('Off');
    expect(slaHoursLabel(4)).toBe('4 hours');
    expect(slaHoursLabel(24)).toBe('1 day');
    expect(slaHoursLabel(120)).toBe('5 days');
    expect(slaHoursLabel(168)).toBe('1 week');
    expect(slaHoursLabel(336)).toBe('2 weeks');
    expect(slaHoursLabel(30)).toBe('1 day 6 hours');
    expect(slaHoursLabel(1)).toBe('1 hour');
  });
});
