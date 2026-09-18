/**
 * Field validators for the shapes the API contract fixes. These mirror the
 * server's rules so a refusal can be shown before a request is spent; the
 * server stays the authority and rejects anything that slips past.
 */

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
