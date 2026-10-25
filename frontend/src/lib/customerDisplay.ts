/**
 * How customer fields read in lists and on the customer page: the status or
 * tier looked up in the workspace's lists, compact amounts for revenue and
 * headcount, and the domains joined for one line.
 */

import type { CustomerFieldRead } from '../types/Api';

const SEEDED_AT = '1970-01-01T00:00:00Z';

/**
 * The statuses every workspace starts with, standing in until the
 * workspace's own list arrives. They match the backend's seeded rows.
 */
export const DEFAULT_CUSTOMER_STATUSES: CustomerFieldRead[] = (
  [
    ['lead', 'Lead', '#8a8f98'],
    ['trial', 'Trial', '#5e6ad2'],
    ['active', 'Active', '#4cb782'],
    ['paused', 'Paused', '#f2c94c'],
    ['churned', 'Churned', '#eb5757'],
  ] as const
).map(([id, name, color], position) => ({
  id,
  name,
  color,
  position,
  customer_count: 0,
  created_at: SEEDED_AT,
  updated_at: SEEDED_AT,
}));

/**
 * The entry a customer holds, looked up by id in the list, or rebuilt from the
 * id and name the customer carries when the list has not caught up.
 */
export const customerFieldOf = (
  fields: readonly CustomerFieldRead[],
  id: string | null | undefined,
  name?: string | null
): CustomerFieldRead | null => {
  if (id === null || id === undefined || id === '') return null;
  const found = fields.find((field) => field.id === id);
  if (found !== undefined) return found;
  return {
    id,
    name: name ?? id,
    color: null,
    position: fields.length,
    customer_count: 0,
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
  };
};

/** A status or tier's name, or a fallback when unset. */
export const customerFieldLabel = (
  field: CustomerFieldRead | null | undefined,
  fallback: string
): string => field?.name ?? fallback;

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
