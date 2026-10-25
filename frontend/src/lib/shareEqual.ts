/**
 * Structural sharing for polled reads. A poll answers with fresh objects even
 * when nothing changed, and every memo, context and memoized row below it
 * compares by identity, so an unchanged answer would redraw the whole page.
 * Folding the new answer into the last one keeps every part that is equal as
 * the very object held before, so only what really changed gets a new
 * identity and only the components that read it render again.
 */

/** Whether a value is a plain object, the only kind of object compared by field. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** The string id a plain object carries, or undefined. */
const idOf = (value: unknown): string | undefined => {
  if (!isPlainObject(value)) return undefined;
  const id = value.id;
  return typeof id === 'string' ? id : undefined;
};

/**
 * The entries of an earlier array by id, when every entry has one, so an
 * entry inserted or moved still meets its own earlier self.
 */
const byIdOf = (items: readonly unknown[]): Map<string, unknown> | null => {
  const map = new Map<string, unknown>();
  for (const item of items) {
    const id = idOf(item);
    if (id === undefined) return null;
    map.set(id, item);
  }
  return map;
};

/** Shares an array, matching entries by id where they carry one. */
const shareArray = (prev: readonly unknown[], next: readonly unknown[]) => {
  const prevById = byIdOf(prev);
  let same = prev.length === next.length;
  const out = next.map((item, index) => {
    const id = prevById === null ? undefined : idOf(item);
    const earlier =
      id === undefined || prevById === null ? prev[index] : prevById.get(id);
    const shared = shareEqual(earlier, item);
    if (shared !== prev[index]) same = false;
    return shared;
  });
  return same ? prev : out;
};

/** Shares a plain object field by field. */
const shareObject = (
  prev: Record<string, unknown>,
  next: Record<string, unknown>
) => {
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(prev).length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const shared = shareEqual(prev[key], next[key]);
    out[key] = shared;
    if (shared !== prev[key] || !Object.hasOwn(prev, key)) same = false;
  }
  return same ? prev : out;
};

/**
 * The next value with every part equal to the previous one swapped for the
 * previous object, and the previous value itself when the two are equal
 * throughout. Arrays and plain objects are compared by content; anything
 * else, such as a Map, a Set or a function, is equal only to itself.
 */
export const shareEqual = <T>(prev: unknown, next: T): T => {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(prev) && Array.isArray(next)) {
    return shareArray(prev, next) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    return shareObject(prev, next) as T;
  }
  return next;
};
