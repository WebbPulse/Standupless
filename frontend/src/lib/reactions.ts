/**
 * The 24 emoji a reaction may carry. This is product content rather than a
 * platform gap, so it stays here rather than moving into the shared packages:
 * the set is a decision about what this product's reactions mean, and another
 * product would pick a different one.
 *
 * The order is the order the picker offers them in, commonest first, so the
 * reactions a thread actually uses are reachable without reading the whole set.
 */

/** The emoji the contract's allow list accepts, in picker order. */
export const REACTION_EMOJI: string[] = [
  '👍',
  '👎',
  '😄',
  '🎉',
  '😕',
  '❤️',
  '🚀',
  '👀',
  '🙏',
  '🔥',
  '💯',
  '✅',
  '❌',
  '⚠️',
  '🐛',
  '💡',
  '📝',
  '⏳',
  '🤔',
  '👏',
  '🙌',
  '😅',
  '🤝',
  '⭐',
];

/** How each emoji reads to a screen reader, since the glyph alone does not. */
export const REACTION_LABELS: Record<string, string> = {
  '👍': 'Thumbs up',
  '👎': 'Thumbs down',
  '😄': 'Smile',
  '🎉': 'Celebrate',
  '😕': 'Confused',
  '❤️': 'Heart',
  '🚀': 'Rocket',
  '👀': 'Eyes',
  '🙏': 'Thanks',
  '🔥': 'Fire',
  '💯': 'Hundred',
  '✅': 'Done',
  '❌': 'Cross',
  '⚠️': 'Warning',
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
 * Whether an emoji is one the server will accept. The picker only offers the
 * allow list, but a group arriving from a read is checked too, so an emoji
 * dropped from the list later renders rather than crashing the thread.
 */
export const isAllowedReaction = (emoji: string): boolean =>
  REACTION_EMOJI.includes(emoji);

/**
 * How one reaction group reads to a screen reader, naming the emoji and how
 * many people chose it, because the count beside a glyph says neither.
 */
export const reactionLabel = (emoji: string, count: number): string => {
  const name = REACTION_LABELS[emoji] ?? emoji;
  return count === 1 ? `${name}, 1 person` : `${name}, ${count} people`;
};
