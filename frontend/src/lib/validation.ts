/**
 * Field validators for the shapes the API contract fixes. These mirror the
 * server's rules so a refusal can be shown before a request is spent; the
 * server stays the authority and rejects anything that slips past.
 */

import type { EstimateScale } from '../types/Api';

/** The slug shape the contract fixes: lowercase, `[a-z0-9-]{3,40}`. */
export const SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;

/** The key prefix shape the contract fixes: uppercase, `[A-Z][A-Z0-9]{1,5}`. */
export const KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;

/** The colour shape the contract fixes for a label: `#rrggbb`. */
export const LABEL_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Checks a workspace slug, answering the sentence to show or null when it
 * passes. Blank answers null so an untouched field does not read as an error.
 */
export const validateSlug = (value: string): string | null => {
  if (value === '') return null;
  if (!SLUG_PATTERN.test(value)) {
    return 'Use 3 to 40 characters: lowercase letters, numbers and hyphens.';
  }
  return null;
};

/**
 * Checks a project key prefix, answering the sentence to show or null when it
 * passes. Blank answers null so an untouched field does not read as an error.
 */
export const validateKeyPrefix = (value: string): string | null => {
  if (value === '') return null;
  if (!KEY_PREFIX_PATTERN.test(value)) {
    return 'Use 2 to 6 characters: an uppercase letter, then uppercase letters or numbers.';
  }
  return null;
};

/**
 * Checks a label colour, answering the sentence to show or null when it passes.
 */
export const validateLabelColor = (value: string): string | null => {
  if (value === '') return null;
  if (!LABEL_COLOR_PATTERN.test(value)) {
    return 'Use a hex colour such as #3b82f6.';
  }
  return null;
};

/**
 * Derives a candidate slug from a workspace name, so the field arrives filled
 * with something valid rather than empty. Trimmed to the 40 character ceiling.
 */
export const slugFromName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * Derives a candidate key prefix from a project name: the leading alphanumerics
 * of the first word, uppercased and capped at the 6 character ceiling.
 */
export const keyPrefixFromName = (name: string): string =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 6);

/** The longest title the contract accepts. */
export const TITLE_MAX = 200;

/** The largest body the contract accepts, counted in bytes rather than chars. */
export const BODY_MAX_BYTES = 65536;

/** The date shape the contract fixes for a start or due date. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The issue key shape the contract fixes: a project prefix and a number. */
export const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/;

/** The estimates each scale accepts, which the project's scale selects between. */
export const ESTIMATE_CHOICES: Record<EstimateScale, string[]> = {
  off: [],
  fibonacci: ['1', '2', '3', '5', '8', '13', '21'],
  linear: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
  tshirt: ['XS', 'S', 'M', 'L', 'XL'],
};

/**
 * The estimates a project offers. An `off` scale offers none, because the
 * contract accepts only null there.
 */
export const estimateChoices = (scale: EstimateScale): string[] =>
  ESTIMATE_CHOICES[scale];

/**
 * Checks an estimate against the project's scale, answering the sentence to
 * show or null when it passes. Blank means unset, which every scale accepts.
 */
export const validateEstimate = (
  value: string,
  scale: EstimateScale
): string | null => {
  if (value === '') return null;
  if (scale === 'off') {
    return 'This project does not estimate issues.';
  }
  if (!estimateChoices(scale).includes(value)) {
    return `Use one of: ${estimateChoices(scale).join(', ')}.`;
  }
  return null;
};

/**
 * Checks an issue title, answering the sentence to show or null when it passes.
 * Blank answers null so an untouched field does not read as an error.
 */
export const validateTitle = (value: string): string | null => {
  if (value.trim() === '') return null;
  if (value.length > TITLE_MAX) {
    return `Use at most ${String(TITLE_MAX)} characters.`;
  }
  return null;
};

/**
 * Checks an issue body against the byte ceiling, which is what the contract
 * fixes: a multi-byte character costs more than one of its length.
 */
export const validateBody = (value: string): string | null => {
  if (value === '') return null;
  if (new TextEncoder().encode(value).length > BODY_MAX_BYTES) {
    return 'This body is too long. Trim it to 64KB or less.';
  }
  return null;
};

/**
 * Checks a start and due date pair, answering the sentence to show or null when
 * it passes. The contract refuses a due date before its start date.
 */
export const validateDateRange = (
  startDate: string,
  dueDate: string
): string | null => {
  for (const value of [startDate, dueDate]) {
    if (value !== '' && !DATE_PATTERN.test(value)) {
      return 'Use a date such as 2026-09-17.';
    }
  }
  if (startDate !== '' && dueDate !== '' && dueDate < startDate) {
    return 'The due date cannot fall before the start date.';
  }
  return null;
};

/** Whether the text looks like an issue key rather than a title fragment. */
export const looksLikeIssueKey = (value: string): boolean =>
  ISSUE_KEY_PATTERN.test(value.trim());
