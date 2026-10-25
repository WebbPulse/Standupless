/**
 * What the search page decides about a term before it sends it. The index drops
 * single characters and does not hold issue keys, so these predicates keep a
 * call that would be refused, or answered with the wrong thing, from being made
 * at all. They sit here rather than in the page so they can be tested as the plain
 * functions they are.
 */

/**
 * The shortest word the index holds. A single character is not indexed, so the
 * page waits for a second one rather than sending a call that will be refused.
 * The last word typed matches as a prefix, so "notif" finds "notifications".
 */
export const MIN_TERM = 2;

/** Whether any word in the term is long enough for the index to hold it. */
export const hasIndexableTerm = (term: string): boolean =>
  term
    .trim()
    .split(/\s+/)
    .some((word) => word.length >= MIN_TERM);

/** Matches a term that is exactly an issue key, such as `ENG-123`. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Matches a term on its way to being an issue key, such as `ENG-`. Typing a key
 * passes through a trailing hyphen state that is not yet a key but does carry a
 * word the index would hold, and searching it would fire a call for a term the
 * person is not looking for and never sees the results of. A bare word with no
 * hyphen is a real search, so it is deliberately not matched here.
 */
const PARTIAL_KEY = /^[A-Za-z][A-Za-z0-9]*-$/;

/** Whether the term is an issue key, which resolves without the index. */
export const isIssueKey = (term: string): boolean => ISSUE_KEY.test(term);

/** Whether the term is a key still being typed, which is not worth searching. */
export const isPartialIssueKey = (term: string): boolean =>
  PARTIAL_KEY.test(term);
