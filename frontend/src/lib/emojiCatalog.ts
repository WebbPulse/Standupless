/**
 * Every emoji the reaction picker can offer, searchable by name and keyword.
 *
 * The list is `emojibase-data`, the maintained Unicode emoji dataset, rather
 * than one kept here, because the server accepts any single emoji and a list
 * of our own would fall behind each Unicode release. It is loaded on first use
 * as its own chunk, so a page that never opens the picker never downloads it.
 */

import type { CompactEmoji } from 'emojibase';

/** One emoji as the picker shows it. */
export interface EmojiEntry {
  emoji: string;
  label: string;
  keywords: string[];
  group: number;
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

/** Turns the dataset's rows into picker entries, dropping components and ungrouped parts. */
export const toCatalog = (rows: CompactEmoji[]): EmojiEntry[] =>
  rows
    .filter((row) => row.group !== undefined && row.group in EMOJI_GROUP_NAMES)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((row) => ({
      emoji: row.unicode,
      label: row.label,
      keywords: row.tags ?? [],
      group: row.group ?? 0,
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
