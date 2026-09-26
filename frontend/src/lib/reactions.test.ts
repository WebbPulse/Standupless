/**
 * The reaction quick picks and helpers. The quick picks are the backend's
 * list, and either presentation of the same emoji must read as one reaction,
 * because the server stores them as one.
 */

import { describe, expect, it } from 'vitest';
import reactionsJson from './reactions.json';
import {
  REACTION_EMOJI,
  REACTION_LABELS,
  normalizeReaction,
  reactionLabel,
  reactionName,
} from './reactions';

describe('the picker set', () => {
  it('is exactly the generated file the backend writes', () => {
    expect(REACTION_EMOJI).toEqual(reactionsJson);
  });

  it('offers twenty four distinct emoji', () => {
    expect(REACTION_EMOJI).toHaveLength(24);
    expect(new Set(REACTION_EMOJI).size).toBe(24);
  });

  it('carries every emoji the picker offers in the generated file', () => {
    for (const emoji of REACTION_EMOJI) {
      expect(reactionsJson).toContain(emoji);
    }
  });

  it('names every emoji it offers, so none reads as a bare glyph', () => {
    for (const emoji of REACTION_EMOJI) {
      expect(REACTION_LABELS[emoji]).toBeDefined();
    }
  });

  it('holds no emoji the generated file does not', () => {
    expect(reactionsJson.length).toBe(REACTION_EMOJI.length);
  });
});

describe('normalisation', () => {
  it('drops the emoji presentation selector', () => {
    expect(normalizeReaction('❤️')).toBe('❤');
    expect(normalizeReaction('⚠️')).toBe('⚠');
  });

  it('names either presentation of the same emoji', () => {
    expect(reactionName('❤️')).toBe('Heart');
    expect(reactionName('❤')).toBe('Heart');
  });

  it('labels either presentation the same way', () => {
    expect(reactionLabel('❤️', 1)).toBe('Heart, 1 person');
    expect(reactionLabel('❤', 2)).toBe('Heart, 2 people');
  });

  it('reads an emoji outside the quick picks as the glyph itself', () => {
    expect(reactionName('🦄')).toBeUndefined();
    expect(reactionLabel('🦄', 1)).toBe('🦄, 1 person');
  });
});
