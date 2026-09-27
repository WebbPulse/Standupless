/**
 * A set of string keys remembered in local storage, for view state a person
 * expects to find as they left it, such as folded groups and hidden board
 * columns. Storage can be unavailable or hold something another version
 * wrote, so anything unreadable reads as an empty set and a refused write is
 * ignored rather than failing the render.
 */

import { useCallback, useState } from 'react';

/** The set as held, with the storage key it was read from. */
interface Held {
  storageKey: string | undefined;
  keys: ReadonlySet<string>;
}

/** Reads the stored keys, or none when storage is missing or unreadable. */
const readKeys = (storageKey: string | undefined): string[] => {
  if (storageKey === undefined) return [];
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is string => typeof row === 'string');
  } catch {
    return [];
  }
};

/** Writes the keys, dropping the entry once the set is empty. */
const writeKeys = (storageKey: string | undefined, keys: string[]): void => {
  if (storageKey === undefined) return;
  try {
    if (keys.length === 0) globalThis.localStorage.removeItem(storageKey);
    else globalThis.localStorage.setItem(storageKey, JSON.stringify(keys));
  } catch {
    return;
  }
};

/**
 * The set stored under `storageKey` and a toggle for one key in it. Without a
 * storage key the set lives in memory only. A new storage key reads its own
 * set in the same render, so switching views never shows the last one's.
 */
export const useStoredSet = (
  storageKey: string | undefined
): [ReadonlySet<string>, (key: string) => void] => {
  const [held, setHeld] = useState<Held>(() => ({
    storageKey,
    keys: new Set(readKeys(storageKey)),
  }));
  const current: Held =
    held.storageKey === storageKey
      ? held
      : { storageKey, keys: new Set(readKeys(storageKey)) };
  if (current !== held) setHeld(current);

  const toggle = useCallback(
    (key: string) => {
      setHeld((prev): Held => {
        const base =
          prev.storageKey === storageKey
            ? prev.keys
            : new Set(readKeys(storageKey));
        const next = new Set(base);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        writeKeys(storageKey, [...next]);
        return { storageKey, keys: next };
      });
    },
    [storageKey]
  );

  return [current.keys, toggle];
};

export default useStoredSet;
