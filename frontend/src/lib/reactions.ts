/**
 * The reaction quick picks. Any single emoji is a valid reaction, and the
 * picker offers them all, but these lead the picker so the common ones are one
 * tap away. The list is the backend's, exported to `reactions.json` by
 * `backend/scripts/export_reactions.py`, so the two halves cannot drift.
 *
 * The labels and the helpers stay here. They are how this application renders
 * a reaction, not what a reaction may be.
 */

import reactions from './reactions.json';

/** The quick picks, in picker order, read from the generated file. */
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
 * lookup or a held-reaction check matches whichever form the glyph arrived in.
 */
export const normalizeReaction = (emoji: string): string =>
  emoji.normalize('NFC').replaceAll('\uFE0F', '');

/** The name this application gives an emoji, or undefined for one it has no name for. */
export const reactionName = (emoji: string): string | undefined =>
  REACTION_LABELS[normalizeReaction(emoji)];

/**
 * How one reaction group reads to a screen reader, naming the emoji and how
 * many people chose it, because the count beside a glyph says neither.
 */
export const reactionLabel = (emoji: string, count: number): string => {
  const name = reactionName(emoji) ?? emoji;
  return count === 1 ? `${name}, 1 person` : `${name}, ${count} people`;
};
