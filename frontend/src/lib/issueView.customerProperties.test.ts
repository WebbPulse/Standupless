/**
 * The helpers behind the SLA, Customers and Customer revenue display
 * properties: which customers asked for an issue, their summed revenue and how
 * it reads, and which properties need the customer requests read.
 */

import { describe, expect, it } from 'vitest';
import { customerRevenueLabel } from './customerDisplay';
import {
  customerRevenueOf,
  customersOf,
  DEFAULT_VISIBLE,
  DISPLAY_PROPERTIES,
  PROPERTY_LABELS,
  showsCustomerProperties,
  type IssueContext,
} from './issueView';

const customerRequests = new Map([
  ['iss-1', ['c-b', 'c-a', 'c-big', 'c-missing']],
  ['iss-2', ['c-none']],
]);

const context: Pick<IssueContext, 'customers' | 'customerRequests'> = {
  customers: [
    { id: 'c-b', name: 'Beta', revenue: 500 },
    { id: 'c-a', name: 'Alpha', revenue: 500 },
    { id: 'c-big', name: 'Big', revenue: 1200000 },
    { id: 'c-none', name: 'None', revenue: null },
  ],
  customerRequests,
};

describe('customersOf', () => {
  it('lists the requesting customers by revenue, then name, skipping unknown ones', () => {
    expect(customersOf({ id: 'iss-1' }, context).map((c) => c.id)).toEqual([
      'c-big',
      'c-a',
      'c-b',
    ]);
  });

  it('is empty without customers, as for a guest', () => {
    expect(customersOf({ id: 'iss-1' }, { customerRequests })).toEqual([]);
  });

  it('is empty for an issue nobody asked for', () => {
    expect(customersOf({ id: 'iss-9' }, context)).toEqual([]);
  });
});

describe('customerRevenueOf', () => {
  it('sums the revenue of the requesting customers', () => {
    expect(customerRevenueOf({ id: 'iss-1' }, context)).toBe(1201000);
  });

  it('reads a customer without revenue as zero', () => {
    expect(customerRevenueOf({ id: 'iss-2' }, context)).toBe(0);
  });
});

describe('customerRevenueLabel', () => {
  it('reads as a compact currency amount', () => {
    expect(customerRevenueLabel(12500)).toBe('$12.5K');
    expect(customerRevenueLabel(1201000)).toBe('$1.2M');
    expect(customerRevenueLabel(800)).toBe('$800');
  });

  it('is null at zero, so the chip is hidden', () => {
    expect(customerRevenueLabel(0)).toBeNull();
  });
});

describe('the display properties', () => {
  it('offers SLA, Customers and Customer revenue', () => {
    expect(DISPLAY_PROPERTIES).toEqual(
      expect.arrayContaining(['sla', 'customers', 'customer_revenue'])
    );
    expect(PROPERTY_LABELS.sla).toBe('SLA');
    expect(PROPERTY_LABELS.customers).toBe('Customers');
    expect(PROPERTY_LABELS.customer_revenue).toBe('Customer revenue');
  });

  it('shows SLA by default and the customer properties only when asked', () => {
    expect(DEFAULT_VISIBLE).toContain('sla');
    expect(DEFAULT_VISIBLE).not.toContain('customers');
    expect(DEFAULT_VISIBLE).not.toContain('customer_revenue');
  });

  it('needs the customer requests only for a customer property', () => {
    expect(showsCustomerProperties(['id', 'sla'])).toBe(false);
    expect(showsCustomerProperties(['customers'])).toBe(true);
    expect(showsCustomerProperties(['customer_revenue'])).toBe(true);
  });
});
