/**
 * The billing display helpers. The byte sizes and the Checkout return
 * sentence are what a person reads, so each rounding and each branch is pinned.
 */

import { describe, expect, it } from 'vitest';
import {
  checkoutOutcome,
  formatBytes,
  PLAN_OFFERS,
  type PlanOffer,
  planIncludes,
  planName,
  priceLine,
  subscriptionStatusLabel,
  usagePercent,
} from './billing';

describe('formatBytes', () => {
  it('reads nothing and small counts in bytes', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(512)).toBe('512 bytes');
  });

  it('rounds larger counts to one decimal in binary units', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB');
    expect(formatBytes(100 * 1024 ** 3 + 300 * 1024 ** 2)).toBe('100.3 GB');
  });
});

describe('usagePercent', () => {
  it('clamps to the bar', () => {
    expect(usagePercent(0, 100)).toBe(0);
    expect(usagePercent(50, 100)).toBe(50);
    expect(usagePercent(150, 100)).toBe(100);
    expect(usagePercent(1, 0)).toBe(100);
  });
});

describe('plan copy', () => {
  it('prices each paid plan per seat by interval', () => {
    const [standard, business] = PLAN_OFFERS as [PlanOffer, PlanOffer];
    expect(priceLine(standard, 'year')).toBe(
      '$6 per seat per month, billed annually'
    );
    expect(priceLine(standard, 'month')).toBe(
      '$8 per seat per month, billed monthly'
    );
    expect(priceLine(business, 'year')).toContain('$10');
    expect(priceLine(business, 'month')).toContain('$12');
  });

  it('names plans and statuses', () => {
    expect(planName('standard')).toBe('Standard');
    expect(planName('')).toBe('Free');
    expect(subscriptionStatusLabel('past_due')).toBe('Payment past due');
    expect(subscriptionStatusLabel(null)).toBeNull();
  });

  it('reads the Checkout return only for its two outcomes', () => {
    expect(checkoutOutcome('success')?.tone).toBe('success');
    expect(checkoutOutcome('cancelled')?.tone).toBe('info');
    expect(checkoutOutcome(null)).toBeNull();
    expect(checkoutOutcome('other')).toBeNull();
  });
});

describe('planIncludes', () => {
  it('gives triage from Standard and SLAs from Business', () => {
    expect(planIncludes('free', 'triage')).toBe(false);
    expect(planIncludes('standard', 'triage')).toBe(true);
    expect(planIncludes('business', 'triage')).toBe(true);
    expect(planIncludes('free', 'issue_slas')).toBe(false);
    expect(planIncludes('standard', 'issue_slas')).toBe(false);
    expect(planIncludes('business', 'issue_slas')).toBe(true);
  });

  it('leaves an unknown plan to the server', () => {
    expect(planIncludes(undefined, 'issue_slas')).toBe(true);
    expect(planIncludes('enterprise', 'issue_slas')).toBe(true);
  });
});
