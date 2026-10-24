/**
 * Every emoji the reaction picker and the editor's `:` shortcode menu can
 * offer, searchable by name, keyword and shortcode.
 *
 * The list is `emojibase-data`, the maintained Unicode emoji dataset, rather
 * than one kept here, because the server accepts any single emoji and a list
 * of our own would fall behind each Unicode release. It is loaded on first use
 * as its own chunk, so a page that never opens the picker never downloads it.
 */

import type { CompactEmoji, ShortcodesDataset } from 'emojibase';

/** One emoji as the picker shows it. */
export interface EmojiEntry {
  emoji: string;
  label: string;
  keywords: string[];
  group: number;
  /** The `:name:` codes that type it, without colons, GitHub's first. */
  shortcodes?: string[];
}

/** A section of the full list, in the order Unicode sorts them. */
export interface EmojiSection {
  group: number;
  name: string;
  entries: EmojiEntry[];
}

/**
 * Unicode's emoji groups by emojibase id. Group 2, the skin tone and hair
 * components, is left out: a component alone is not a reaction and the server
 * refuses it.
 */
export const EMOJI_GROUP_NAMES: Record<number, string> = {
  0: 'Smileys and emotion',
  1: 'People and body',
  3: 'Animals and nature',
  4: 'Food and drink',
  5: 'Travel and places',
  6: 'Activities',
  7: 'Objects',
  8: 'Symbols',
  9: 'Flags',
};

/** The shortcode a label reads as, such as `face_with_tears_of_joy`. */
export const labelShortcode = (label: string): string =>
  label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9+-]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** An emoji's shortcodes: the dataset's, then its label's, without repeats. */
const shortcodesOf = (
  row: CompactEmoji,
  shortcodes: ShortcodesDataset
): string[] => {
  const listed = shortcodes[row.hexcode];
  const named = listed === undefined ? [] : [listed].flat();
  return Array.from(new Set([...named, labelShortcode(row.label)])).filter(
    Boolean
  );
};

/**
 * Turns the dataset's rows into picker entries, dropping components and
 * ungrouped parts. Given a shortcode dataset, each entry carries its codes.
 */
export const toCatalog = (
  rows: CompactEmoji[],
  shortcodes?: ShortcodesDataset
): EmojiEntry[] =>
  rows
    .filter((row) => row.group !== undefined && row.group in EMOJI_GROUP_NAMES)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((row) => ({
      emoji: row.unicode,
      label: row.label,
      keywords: row.tags ?? [],
      group: row.group ?? 0,
      ...(shortcodes === undefined
        ? {}
        : { shortcodes: shortcodesOf(row, shortcodes) }),
    }));

let pending: Promise<EmojiEntry[]> | null = null;

/** Loads the catalog once, sharing the one download between every picker. */
export const loadEmojiCatalog = (): Promise<EmojiEntry[]> => {
  pending ??= import('emojibase-data/en/compact.json')
    .then((module) => toCatalog(module.default))
    .catch((failure: unknown) => {
      pending = null;
      throw failure;
    });
  return pending;
};

/** The catalog split into its Unicode groups, for the unfiltered view. */
export const sectionsOf = (catalog: EmojiEntry[]): EmojiSection[] => {
  const sections = new Map<number, EmojiEntry[]>();
  for (const entry of catalog) {
    const rows = sections.get(entry.group) ?? [];
    rows.push(entry);
    sections.set(entry.group, rows);
  }
  return Array.from(sections, ([group, entries]) => ({
    group,
    name: EMOJI_GROUP_NAMES[group] ?? 'Other',
    entries,
  }));
};

/**
 * The entries a search names, best match first: a name that starts with the
 * query, then a word in the name that does, then a keyword that does, each in
 * Unicode order. Every word of a multi-word query must match somewhere.
 */
export const searchEmoji = (
  catalog: EmojiEntry[],
  query: string,
  limit = 80
): EmojiEntry[] => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { entry: EmojiEntry; score: number }[] = [];
  for (const entry of catalog) {
    const label = entry.label.toLowerCase();
    const labelWords = label.split(/[\s:,-]+/);
    let score = 0;
    let matched = true;
    for (const word of words) {
      if (label.startsWith(word)) score += 0;
      else if (labelWords.some((part) => part.startsWith(word))) score += 1;
      else if (entry.keywords.some((keyword) => keyword.startsWith(word)))
        score += 2;
      else if (label.includes(word)) score += 3;
      else {
        matched = false;
        break;
      }
    }
    if (matched) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
};

let pendingShortcodes: Promise<EmojiEntry[]> | null = null;
let loadedShortcodes: EmojiEntry[] | null = null;

/**
 * Loads the catalog with GitHub's shortcodes once, for the editor's `:` menu.
 * It is a separate download from the picker's, so reacting never pays for it.
 */
export const loadShortcodeCatalog = (): Promise<EmojiEntry[]> => {
  pendingShortcodes ??= Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/shortcodes/github.json'),
  ])
    .then(([rows, codes]) => {
      loadedShortcodes = toCatalog(
        rows.default,
        codes.default as ShortcodesDataset
      );
      return loadedShortcodes;
    })
    .catch((failure: unknown) => {
      pendingShortcodes = null;
      throw failure;
    });
  return pendingShortcodes;
};

/** The shortcode catalog if it has loaded, or null. */
export const loadedShortcodeCatalog = (): EmojiEntry[] | null =>
  loadedShortcodes;

/** How well one shortcode matches a query: lower is better, null is none. */
const shortcodeRank = (code: string, query: string): number | null => {
  if (code === query) return 0;
  if (code.startsWith(query)) return 1;
  if (code.split(/[_-]/).some((part) => part.startsWith(query))) return 2;
  return null;
};

/** How well an entry matches a shortcode query: lower is better, null is none. */
const entryRank = (entry: EmojiEntry, query: string): number | null => {
  let best: number | null = null;
  for (const code of entry.shortcodes ?? []) {
    const rank = shortcodeRank(code, query);
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  if (best !== null) return best;
  if (entry.keywords.some((keyword) => keyword.startsWith(query))) return 3;
  return null;
};

/**
 * The entries a `:query` names, best first: recently used emoji lead, then an
 * exact shortcode, a shortcode that starts with the query, a word of one that
 * does, and a keyword that does, each in Unicode order.
 */
export const searchShortcodes = (
  catalog: EmojiEntry[],
  query: string,
  recent: string[] = [],
  limit = 8
): EmojiEntry[] => {
  const typed = query.trim().toLowerCase();
  if (typed === '') return [];
  const order = new Map(recent.map((emoji, index) => [emoji, index]));
  const scored: { entry: EmojiEntry; recent: number; rank: number }[] = [];
  catalog.forEach((entry) => {
    const rank = entryRank(entry, typed);
    if (rank === null) return;
    scored.push({
      entry,
      recent: order.get(entry.emoji) ?? recent.length,
      rank,
    });
  });
  return scored
    .sort((a, b) => a.recent - b.recent || a.rank - b.rank)
    .slice(0, limit)
    .map(({ entry }) => entry);
};

/** The entry a shortcode names exactly, or undefined. */
export const findShortcode = (
  catalog: EmojiEntry[],
  code: string
): EmojiEntry | undefined => {
  const typed = code.toLowerCase();
  return catalog.find((entry) => entry.shortcodes?.includes(typed) === true);
};

/** Where this browser keeps the emoji the `:` menu inserted most recently. */
export const RECENT_EMOJI_STORAGE_KEY = 'standupless.recentEmoji';

/** How many recently used emoji are kept. */
export const RECENT_EMOJI_LIMIT = 16;

/** The emoji this browser inserted most recently, newest first. */
export const recentEmoji = (): string[] => {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY) ?? '[]'
    );
    return Array.isArray(stored)
      ? stored
          .filter((value): value is string => typeof value === 'string')
          .slice(0, RECENT_EMOJI_LIMIT)
      : [];
  } catch {
    return [];
  }
};

/** Puts an emoji at the front of the recently used list. */
export const rememberEmoji = (emoji: string): void => {
  const next = [emoji, ...recentEmoji().filter((held) => held !== emoji)];
  try {
    window.localStorage.setItem(
      RECENT_EMOJI_STORAGE_KEY,
      JSON.stringify(next.slice(0, RECENT_EMOJI_LIMIT))
    );
  } catch {
    return;
  }
};
