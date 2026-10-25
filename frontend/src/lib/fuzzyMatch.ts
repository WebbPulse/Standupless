/**
 * Deterministic fuzzy matching for the command palette, so "asgn me" finds
 * Assign to me and "chst" finds Change status the way Linear's menu does.
 *
 * Every typed word is scored on its own against a row's label and then its
 * extra texts, such as keywords, aliases and hints, and a row matches only when
 * every word lands somewhere. A word scores by the best tier it reaches: a
 * prefix of the label, a prefix of one of its words, the initials of
 * consecutive words, a plain substring, an in-order subsequence that only skips
 * letters inside a word or jumps to the start of a later one, and last, for
 * words of four or more letters, the same with one transposed or one extra
 * character. Within a tier the only penalty is the letters a subsequence skips,
 * so equal rows keep the order their section gave them.
 *
 * The scorer is pure and allocation light. Each text is prepared once and
 * cached, and the work per row is bounded by its text length, so filtering a
 * list is linear in its rows.
 */

/** A half open run of matched characters in a label, as [start, end). */
export type MatchRange = readonly [number, number];

/** How a row scored against a query: zero means it did not match. */
export interface FuzzyMatch {
  score: number;
  /** The matched runs of the label, sorted and merged, for highlighting. */
  ranges: readonly MatchRange[];
}

/** One ranked row with the match that placed it. */
export interface RankedRow<T> {
  row: T;
  match: FuzzyMatch;
}

const LABEL_PREFIX = 900;
const WORD_PREFIX = 800;
const INITIALS = 700;
const SUBSTRING = 600;
const SUBSEQUENCE = 400;
const SUBSEQUENCE_FLOOR = 200;
const TYPO = 250;
const TYPO_FLOOR = 100;
const GAP_COST = 10;
const TYPO_GAP_COST = 5;
const EXTRA_WEIGHT = 0.5;
const PHRASE_BONUS = 200;
const TYPO_MIN_LENGTH = 4;
const MAX_TEXT = 512;
const MAX_WORD = 32;
const CACHE_LIMIT = 8000;

/** A text lowercased once, with where its words start and its initials. */
interface Prepared {
  lower: string;
  starts: Uint8Array;
  words: Uint16Array;
  initials: string;
  initialAt: number[];
}

const NO_MATCH: FuzzyMatch = { score: 0, ranges: [] };
const EVERYTHING: FuzzyMatch = { score: 1, ranges: [] };

const cache = new Map<string, Prepared>();

/** Whether a character is a letter or a digit, so word starts can be found. */
const isWordChar = (char: string): boolean => /[\p{L}\p{N}]/u.test(char);

/** Lowercases a text and marks its word starts, cached by the text itself. */
const prepare = (text: string): Prepared => {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const source = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const lower = source.toLowerCase();
  const length = lower.length;
  const starts = new Uint8Array(length);
  const words = new Uint16Array(length);
  const initialAt: number[] = [];
  let initials = '';
  let word = 0;
  for (let at = 0; at < length; at += 1) {
    const char = source.charAt(at);
    if (!isWordChar(char)) {
      words[at] = word;
      continue;
    }
    const previous = at === 0 ? '' : source.charAt(at - 1);
    const camel =
      previous !== '' &&
      previous === previous.toLowerCase() &&
      previous !== previous.toUpperCase() &&
      char !== char.toLowerCase();
    if (at === 0 || !isWordChar(previous) || camel) {
      starts[at] = 1;
      word += 1;
      initials += lower.charAt(at);
      initialAt.push(at);
    }
    words[at] = word;
  }
  const prepared = { lower, starts, words, initials, initialAt };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(text, prepared);
  return prepared;
};

/** The words of a query, lowercased, with blanks dropped. */
export const queryWords = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => (word.length > MAX_WORD ? word.slice(0, MAX_WORD) : word));

/**
 * The positions of an in-order subsequence that starts on a word start and
 * only skips letters inside the word it is in, or jumps to a later word start.
 * A memo of failed states keeps it within letters times characters.
 */
const subsequence = (text: Prepared, word: string): number[] | null => {
  const { lower, starts, words } = text;
  const length = lower.length;
  if (word.length > length) return null;
  const failed = new Uint8Array(word.length * length);
  const positions: number[] = [];
  const walk = (letter: number, from: number, previous: number): boolean => {
    if (letter === word.length) return true;
    const char = word.charAt(letter);
    for (let at = from; at < length; at += 1) {
      if (letter > 0 && starts[at] !== 1 && words[at] !== words[previous]) {
        while (at + 1 < length && starts[at + 1] !== 1) at += 1;
        continue;
      }
      if (lower.charAt(at) !== char) continue;
      if (letter === 0 && starts[at] !== 1) continue;
      const key = letter * length + at;
      if (failed[key] === 1) continue;
      positions.push(at);
      if (walk(letter + 1, at + 1, at)) return true;
      positions.pop();
      failed[key] = 1;
    }
    return false;
  };
  return walk(0, 0, -1) ? positions : null;
};

/** A run of positions from a start, for prefix and substring tiers. */
const run = (start: number, length: number): number[] =>
  Array.from({ length }, (_, offset) => start + offset);

/** The best exact tier a word reaches in a text, without typo tolerance. */
const exactTier = (
  text: Prepared,
  word: string,
  typo: boolean
): { score: number; positions: number[] } | null => {
  const { lower, starts, initials, initialAt } = text;
  const first = lower.indexOf(word);
  if (first === 0) {
    return {
      score: typo ? TYPO : LABEL_PREFIX,
      positions: run(0, word.length),
    };
  }
  if (first > 0) {
    let at = first;
    while (at >= 0 && starts[at] !== 1) at = lower.indexOf(word, at + 1);
    if (at >= 0) {
      return {
        score: typo ? TYPO : WORD_PREFIX,
        positions: run(at, word.length),
      };
    }
  }
  if (word.length >= 2) {
    const initial = initials.indexOf(word);
    if (initial >= 0) {
      return {
        score: typo ? TYPO : INITIALS,
        positions: initialAt.slice(initial, initial + word.length),
      };
    }
  }
  if (first > 0) {
    return {
      score: typo ? TYPO : SUBSTRING,
      positions: run(first, word.length),
    };
  }
  const positions = subsequence(text, word);
  if (positions === null) return null;
  const span = (positions.at(-1) ?? 0) - (positions[0] ?? 0) + 1;
  const gaps = span - word.length;
  return typo
    ? { score: Math.max(TYPO_FLOOR, TYPO - gaps * TYPO_GAP_COST), positions }
    : {
        score: Math.max(SUBSEQUENCE_FLOOR, SUBSEQUENCE - gaps * GAP_COST),
        positions,
      };
};

/** The query word with one character dropped or two neighbours swapped. */
const typoVariants = (word: string): string[] => {
  const variants = new Set<string>();
  for (let at = 0; at < word.length; at += 1) {
    variants.add(word.slice(0, at) + word.slice(at + 1));
    if (at + 1 < word.length) {
      variants.add(
        word.slice(0, at) +
          word.charAt(at + 1) +
          word.charAt(at) +
          word.slice(at + 2)
      );
    }
  }
  variants.delete(word);
  return [...variants].filter((variant) => variant.length > 0);
};

/**
 * Scores one query word against one text, falling back to one transposed or
 * extra character for words of four or more letters.
 */
export const scoreWord = (
  text: string,
  word: string
): { score: number; positions: number[] } | null => {
  if (word === '') return { score: 0, positions: [] };
  const prepared = prepare(text);
  if (prepared.lower.length === 0) return null;
  const exact = exactTier(prepared, word, false);
  if (exact !== null || word.length < TYPO_MIN_LENGTH) return exact;
  let best: { score: number; positions: number[] } | null = null;
  for (const variant of typoVariants(word)) {
    const found = exactTier(prepared, variant, true);
    if (found !== null && (best === null || found.score > best.score)) {
      best = found;
    }
  }
  return best;
};

/** Sorted positions folded into merged half open runs. */
const toRanges = (positions: readonly number[]): MatchRange[] => {
  const sorted = [...new Set(positions)].sort((left, right) => left - right);
  const ranges: [number, number][] = [];
  for (const at of sorted) {
    const last = ranges.at(-1);
    if (last !== undefined && last[1] === at) last[1] = at + 1;
    else ranges.push([at, at + 1]);
  }
  return ranges;
};

/**
 * Scores a row against a query: its label first, then its extra texts at half
 * weight. Every word must land in one of them, and a label that starts with
 * the whole query gets a bonus so a typed name beats a scattered match.
 */
export const fuzzyMatch = (
  label: string,
  extras: readonly string[],
  query: string
): FuzzyMatch => {
  const words = queryWords(query);
  if (words.length === 0) return EVERYTHING;
  let total = 0;
  const positions: number[] = [];
  for (const word of words) {
    const inLabel = scoreWord(label, word);
    let best = inLabel?.score ?? 0;
    let fromLabel = inLabel !== null;
    for (const extra of extras) {
      if (extra === '') continue;
      const found = scoreWord(extra, word);
      if (found !== null && found.score * EXTRA_WEIGHT > best) {
        best = found.score * EXTRA_WEIGHT;
        fromLabel = false;
      }
    }
    if (best <= 0) return NO_MATCH;
    total += best;
    if (fromLabel && inLabel !== null) positions.push(...inLabel.positions);
  }
  const phrase = words.join(' ');
  if (words.length > 1 && prepare(label).lower.startsWith(phrase)) {
    total += PHRASE_BONUS;
  }
  return { score: total, ranges: toRanges(positions) };
};

/**
 * Ranks rows against a query, best first, leaving out rows that score zero.
 * Ties keep the order the rows came in, then fall back to the label's
 * alphabetical order. An empty query keeps every row in its order.
 */
export const rankRows = <T>(
  rows: readonly T[],
  query: string,
  labelOf: (row: T) => string,
  extrasOf: (row: T) => readonly string[]
): RankedRow<T>[] => {
  if (queryWords(query).length === 0) {
    return rows.map((row) => ({ row, match: EVERYTHING }));
  }
  const scored: { row: T; match: FuzzyMatch; at: number; label: string }[] = [];
  rows.forEach((row, at) => {
    const label = labelOf(row);
    const match = fuzzyMatch(label, extrasOf(row), query);
    if (match.score > 0) scored.push({ row, match, at, label });
  });
  scored.sort(
    (left, right) =>
      right.match.score - left.match.score ||
      left.at - right.at ||
      left.label.localeCompare(right.label)
  );
  return scored.map(({ row, match }) => ({ row, match }));
};
