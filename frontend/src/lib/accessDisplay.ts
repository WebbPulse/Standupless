/**
 * How the access rows read in the interface. Kept apart from the components so
 * the same wording is used by the key list, the share list and the anonymous
 * share page rather than being spelled out three times.
 */

import type { ApiKeyKind, ApiKeyRead, ShareTargetType } from '../types/Api';

/** How a date reads in a list, or a dash when the field is absent. */
export const dateLabel = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleDateString();
};

/** How a key's kind reads in the interface. */
export const kindLabel = (kind: ApiKeyKind): string =>
  kind === 'workspace' ? 'Workspace key' : 'Personal key';

/** How a share target's kind reads in the interface. */
export const targetTypeLabel = (targetType: ShareTargetType): string => {
  if (targetType === 'view') return 'View';
  if (targetType === 'filter') return 'Filter';
  return 'Issue';
};

/**
 * Whether a key can still be spent. A revoked or expired key stays in the list
 * rather than vanishing, because a row that disappeared would be impossible to
 * tell from one that never existed, so the list has to say which it is.
 */
export const isKeyLive = (key: ApiKeyRead, now: Date = new Date()): boolean => {
  if (key.revoked_at !== null) return false;
  if (key.expires_at === null) return true;
  const expiry = new Date(key.expires_at);
  return Number.isNaN(expiry.getTime()) || expiry.getTime() > now.getTime();
};

/** The one word a key's row leads with: whether it still works. */
export const keyStateLabel = (
  key: ApiKeyRead,
  now: Date = new Date()
): string => {
  if (key.revoked_at !== null) return 'Revoked';
  return isKeyLive(key, now) ? 'Active' : 'Expired';
};

/** Whether a share link can still be opened. */
export const isLinkLive = (
  expiresAt: string | null,
  now: Date = new Date()
): boolean => {
  if (expiresAt === null) return true;
  const expiry = new Date(expiresAt);
  return Number.isNaN(expiry.getTime()) || expiry.getTime() > now.getTime();
};

/** The lowest and highest `expires_in_days` the contract accepts. */
export const MIN_EXPIRY_DAYS = 1;

/** The highest `expires_in_days` the contract accepts. */
export const MAX_EXPIRY_DAYS = 365;

/**
 * Reads the expiry box into what the create body should carry. An empty box is
 * a key that does not expire, which is absence rather than a zero, and anything
 * outside the accepted range is refused here so the server's 422 is not the
 * first time a person hears about it.
 */
export const parseExpiryDays = (
  raw: string
): { ok: true; days: number | undefined } | { ok: false; message: string } => {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, days: undefined };
  const days = Number(trimmed);
  if (!Number.isInteger(days)) {
    return { ok: false, message: 'Expiry must be a whole number of days.' };
  }
  if (days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS) {
    return {
      ok: false,
      message: `Expiry must be between ${String(MIN_EXPIRY_DAYS)} and ${String(MAX_EXPIRY_DAYS)} days.`,
    };
  }
  return { ok: true, days };
};
