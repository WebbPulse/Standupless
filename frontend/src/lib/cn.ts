/**
 * Joins class names, dropping the falsy ones, so a component can build its
 * class list from conditions without a template literal full of blanks.
 */

/** One entry in a class list: a string, or a value that switches it off. */
export type ClassValue = string | false | null | undefined;

/** Joins the truthy entries with a single space. */
export const cn = (...values: ClassValue[]): string =>
  values.filter((value): value is string => Boolean(value)).join(' ');
