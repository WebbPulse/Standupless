/**
 * How customer fields read in lists and on the customer page: compact amounts
 * for revenue and headcount, and the domains joined for one line.
 */

const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Revenue as a compact amount such as $1.2M, or null when unset. */
export const revenueLabel = (revenue: number | null): string | null =>
  revenue === null ? null : `$${COMPACT.format(revenue)}`;

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
