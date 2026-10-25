/**
 * How customer fields read in lists and on the customer page: the status with
 * its label and dot colour, compact amounts for revenue and headcount, and the
 * domains joined for one line.
 */

import type { CustomerStatus } from '../types/Api';

/** Every customer status, in the order a customer usually moves through them. */
export const CUSTOMER_STATUSES: CustomerStatus[] = [
  'lead',
  'trial',
  'active',
  'paused',
  'churned',
];

/** How a customer status reads in the interface. */
export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  lead: 'Lead',
  trial: 'Trial',
  active: 'Active',
  paused: 'Paused',
  churned: 'Churned',
};

/** The dot colour beside each status. */
export const CUSTOMER_STATUS_DOT: Record<CustomerStatus, string> = {
  lead: 'bg-text-faint',
  trial: 'bg-accent',
  active: 'bg-success',
  paused: 'bg-warning',
  churned: 'bg-danger',
};

/** A status's label, or a fallback when unset. */
export const customerStatusLabel = (
  status: CustomerStatus | null | undefined,
  fallback = 'No status'
): string =>
  status === null || status === undefined
    ? fallback
    : CUSTOMER_STATUS_LABELS[status];

const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Revenue as a compact amount such as $1.2M, or null when unset. */
export const revenueLabel = (revenue: number | null): string | null =>
  revenue === null ? null : `$${COMPACT.format(revenue)}`;

/** An issue's summed customer revenue as a compact amount, or null when it is zero. */
export const customerRevenueLabel = (revenue: number): string | null =>
  revenue > 0 ? revenueLabel(revenue) : null;

/** Headcount as a compact number such as 1.2K, or null when unset. */
export const sizeLabel = (size: number | null): string | null =>
  size === null ? null : COMPACT.format(size);

/** Domains typed as one comma or space separated line, split into a list. */
export const parseDomains = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** A whole non-negative amount typed as text, or null when blank or invalid. */
export const parseAmount = (text: string): number | null => {
  const cleaned = text.replace(/[\s,$_]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
