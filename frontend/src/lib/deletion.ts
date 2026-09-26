/**
 * The facts the deletion screens state: how long the grace period is and how
 * the purge date reads. The server decides the date; the length is here only
 * so the copy can say it before anything is scheduled.
 */

/** Days between asking for a deletion and the permanent purge. */
export const DELETION_GRACE_DAYS = 14;

/** How a purge date reads in a banner, in full so it cannot be misread. */
export const purgeDateLabel = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return 'soon';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'soon';
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

/** Whether the typed text matches what has to be typed. */
export const confirmationMatches = (
  typed: string,
  expected: string,
  ignoreCase: boolean
): boolean => {
  const left = typed.trim();
  const right = expected.trim();
  if (left === '') return false;
  return ignoreCase
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
};
