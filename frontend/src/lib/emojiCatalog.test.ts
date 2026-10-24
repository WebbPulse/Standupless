/**
 * The emoji catalog behind the reaction picker: the dataset loads as whole
 * emoji only, grouped the way Unicode groups them, and a search finds an emoji
 * by its name or a keyword with the closest names first.
 */

import { describe, expect, it } from 'vitest';
import {
  EMOJI_GROUP_NAMES,
  findShortcode,
  labelShortcode,
  loadEmojiCatalog,
  loadShortcodeCatalog,
  recentEmoji,
  RECENT_EMOJI_LIMIT,
  RECENT_EMOJI_STORAGE_KEY,
  rememberEmoji,
  searchEmoji,
  searchShortcodes,
  sectionsOf,
  type EmojiEntry,
} from './emojiCatalog';

const entry = (
  emoji: string,
  label: string,
  keywords: string[] = [],
  group = 0
): EmojiEntry => ({ emoji, label, keywords, group });

const sample = [
  entry('😀', 'grinning face', ['face', 'grin']),
  entry('😂', 'face with tears of joy', ['laugh', 'tears']),
  entry('👍', 'thumbs up', ['+1', 'good', 'yes'], 1),
  entry('👍🏽', 'thumbs up: medium skin tone', ['+1'], 1),
  entry('🦄', 'unicorn', ['face'], 3),
];

describe('search', () => {
  it('finds an emoji by the start of its name', () => {
    expect(searchEmoji(sample, 'unic').map((row) => row.emoji)).toEqual(['🦄']);
  });

  it('puts a name that starts with the query before a keyword match', () => {
    expect(searchEmoji(sample, 'face').map((row) => row.emoji)).toEqual([
      '😂',
      '😀',
      '🦄',
    ]);
  });

  it('finds an emoji by a keyword', () => {
    expect(searchEmoji(sample, 'laugh').map((row) => row.emoji)).toEqual([
      '😂',
    ]);
  });

  it('needs every word of the query to match', () => {
    expect(
      searchEmoji(sample, 'thumbs medium').map((row) => row.emoji)
    ).toEqual(['👍🏽']);
  });

  it('answers nothing for an empty query or no match', () => {
    expect(searchEmoji(sample, '  ')).toEqual([]);
    expect(searchEmoji(sample, 'zebra crossing')).toEqual([]);
  });
});

describe('the dataset', () => {
  it('loads whole emoji only, in the named groups', async () => {
    const catalog = await loadEmojiCatalog();
    expect(catalog.length).toBeGreaterThan(1500);
    expect(catalog.every((row) => row.group in EMOJI_GROUP_NAMES)).toBe(true);
    const glyphs = new Set(catalog.map((row) => row.emoji));
    expect(glyphs.has('🦄')).toBe(true);
    expect(glyphs.has('\u{1F3FD}')).toBe(false);
    expect(glyphs.has('\u{1F1FA}')).toBe(false);
  });

  it('splits into sections in Unicode order', async () => {
    const sections = sectionsOf(await loadEmojiCatalog());
    expect(sections[0]?.name).toBe('Smileys and emotion');
    expect(sections.at(-1)?.name).toBe('Flags');
  });

  it('shares one load between callers', () => {
    expect(loadEmojiCatalog()).toBe(loadEmojiCatalog());
  });
});

const coded = (
  emoji: string,
  shortcodes: string[],
  keywords: string[] = []
): EmojiEntry => ({
  ...entry(emoji, shortcodes[0] ?? '', keywords),
  shortcodes,
});

const codedSample = [
  coded('🚀', ['rocket'], ['launch']),
  coded('🪨', ['rock']),
  coded('🎉', ['tada', 'party_popper'], ['celebrate']),
  coded('👍', ['+1', 'thumbsup']),
];

describe('shortcodes', () => {
  it('reads a label as a shortcode', () => {
    expect(labelShortcode('face with tears of joy')).toBe(
      'face_with_tears_of_joy'
    );
    expect(labelShortcode('thumbs up: medium skin tone')).toBe(
      'thumbs_up_medium_skin_tone'
    );
  });

  it('puts an exact shortcode before one that starts with the query', () => {
    expect(
      searchShortcodes(codedSample, 'rock').map((row) => row.emoji)
    ).toEqual(['🪨', '🚀']);
  });

  it('matches a word of a shortcode and then a keyword', () => {
    expect(
      searchShortcodes(codedSample, 'party').map((row) => row.emoji)
    ).toEqual(['🎉']);
    expect(
      searchShortcodes(codedSample, 'launch').map((row) => row.emoji)
    ).toEqual(['🚀']);
  });

  it('ranks recently used emoji first', () => {
    expect(
      searchShortcodes(codedSample, 'roc', ['🚀']).map((row) => row.emoji)
    ).toEqual(['🚀', '🪨']);
  });

  it('finds an exact shortcode in any case', () => {
    expect(findShortcode(codedSample, 'TADA')?.emoji).toBe('🎉');
    expect(findShortcode(codedSample, 'tad')).toBeUndefined();
  });

  it("loads GitHub's shortcodes with the dataset", async () => {
    const catalog = await loadShortcodeCatalog();
    expect(findShortcode(catalog, 'tada')?.label).toBe('party popper');
    expect(findShortcode(catalog, '+1')?.label).toBe('thumbs up');
    expect(findShortcode(catalog, 'rocket')?.label).toBe('rocket');
    expect(findShortcode(catalog, 'party_popper')?.label).toBe('party popper');
  });
});

describe('recently used emoji', () => {
  it('keeps the newest first without repeats, up to the limit', () => {
    rememberEmoji('🚀');
    rememberEmoji('🎉');
    rememberEmoji('🚀');
    expect(recentEmoji()).toEqual(['🚀', '🎉']);
    for (let index = 0; index < RECENT_EMOJI_LIMIT + 4; index += 1) {
      rememberEmoji(String(index));
    }
    expect(recentEmoji()).toHaveLength(RECENT_EMOJI_LIMIT);
  });

  it('reads anything unreadable as an empty list', () => {
    globalThis.localStorage.setItem(RECENT_EMOJI_STORAGE_KEY, '{not json');
    expect(recentEmoji()).toEqual([]);
    globalThis.localStorage.setItem(RECENT_EMOJI_STORAGE_KEY, '{"a":1}');
    expect(recentEmoji()).toEqual([]);
  });
});
