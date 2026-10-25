/**
 * How a custom workspace emoji draws: its image at the size of the text
 * around it, with the `:name:` shortcode as its text alternative, so a copy
 * of the rendered Markdown carries the shortcode the source held. Text runs
 * and reactions that name an emoji the workspace no longer has stay as their
 * `:name:` text.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import {
  customReactionName,
  splitCustomEmoji,
  useCustomEmoji,
} from '../../lib/customEmoji';
import type { CustomEmojiRead } from '../../types/Api';

/** Props for CustomEmojiImage: the emoji and optional classes. */
export interface CustomEmojiImageProps {
  emoji: CustomEmojiRead;
  className?: string;
}

/** One custom emoji image, sized to the text it sits in. */
export const CustomEmojiImage: React.FC<CustomEmojiImageProps> = ({
  emoji,
  className = '',
}) => (
  <img
    src={emoji.url}
    alt={emoji.shortcode}
    title={emoji.shortcode}
    data-md={emoji.shortcode}
    loading="lazy"
    draggable={false}
    className={cn(
      'inline-block h-[1.25em] w-[1.25em] object-contain align-[-0.25em]',
      className
    )}
  />
);

/** A run of Markdown text, with each known `:name:` drawn as its image. */
export const EmojiText: React.FC<{ value: string }> = ({ value }) => {
  const set = useCustomEmoji();
  const parts = splitCustomEmoji(value, set);
  if (parts.length === 1 && typeof parts[0] === 'string') return <>{value}</>;
  return (
    <>
      {parts.map((part, index) =>
        typeof part === 'string' ? (
          <React.Fragment key={index}>{part}</React.Fragment>
        ) : (
          <CustomEmojiImage key={index} emoji={part} />
        )
      )}
    </>
  );
};

/** A reaction's emoji: a Unicode glyph, a custom image, or a deleted one's `:name:`. */
export const ReactionEmoji: React.FC<{ emoji: string; className?: string }> = ({
  emoji,
  className = '',
}) => {
  const set = useCustomEmoji();
  const name = customReactionName(emoji);
  const custom = name === null ? undefined : set.get(name);
  if (custom !== undefined) {
    return <CustomEmojiImage emoji={custom} className={className} />;
  }
  return <>{emoji}</>;
};
