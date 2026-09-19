/**
 * The emoji a reaction may carry. The list itself is the backend's, exported to
 * `reactions.json` by `backend/scripts/export_reactions.py`, because the two
 * halves each kept their own copy and drifted: only fifteen matched, and two
 * more differed by nothing but a trailing variation selector, so the picker
 * offered emoji the API then refused.
 *
 * The labels and the helpers stay here. They are how this application renders
 * the set, not what the set is, and a label added here cannot disagree with the
 * server about what a reaction means.
 *
 * The order is the order the picker offers them in, commonest first, so the
 * reactions a thread actually uses are reachable without reading the whole set.
 */

import reactions from './reactions.json';

/** The emoji the backend accepts, in picker order, read from the generated file. */
export const REACTION_EMOJI: string[] = reactions;

/** How each emoji reads to a screen reader, since the glyph alone does not. */
export const REACTION_LABELS: Record<string, string> = {
  '👍': 'Thumbs up',
  '👎': 'Thumbs down',
  '😄': 'Smile',
  '🎉': 'Celebrate',
  '😕': 'Confused',
  '❤': 'Heart',
  '🚀': 'Rocket',
  '👀': 'Eyes',
  '🙏': 'Thanks',
  '🔥': 'Fire',
  '💯': 'Hundred',
  '✅': 'Done',
  '❌': 'Cross',
  '⚠': 'Warning',
  '🐛': 'Bug',
  '💡': 'Idea',
  '📝': 'Note',
  '⏳': 'Waiting',
  '🤔': 'Thinking',
  '👏': 'Clap',
  '🙌': 'Raised hands',
  '😅': 'Relieved',
  '🤝': 'Handshake',
  '⭐': 'Star',
};

/**
 * One emoji in the form the server stores it in: NFC, with the U+FE0F emoji
 * presentation selector dropped. The server normalises the same way, so a label
 * or an allow-list lookup finds its entry whichever form the glyph arrived in.
 */
export const normalizeReaction = (emoji: string): string =>
  emoji.normalize('NFC').replaceAll('\uFE0F', '');

const ALLOWED = new Set(REACTION_EMOJI.map(normalizeReaction));

/**
 * Whether an emoji is one the picker offers. A group arriving from a read is
 * checked too, so an emoji dropped from the list later renders rather than
 * crashing the thread, and an emoji the backend still accepts but no longer
 * offers reads as one it does not know rather than being hidden.
 */
export const isAllowedReaction = (emoji: string): boolean =>
  ALLOWED.has(normalizeReaction(emoji));

/**
 * How one reaction group reads to a screen reader, naming the emoji and how
 * many people chose it, because the count beside a glyph says neither.
 */
export const reactionLabel = (emoji: string, count: number): string => {
  const name = REACTION_LABELS[normalizeReaction(emoji)] ?? emoji;
  return count === 1 ? `${name}, 1 person` : `${name}, ${count} people`;
};
