/**
 * The reaction allow list. These hold the one thing that actually broke: the
 * picker and the API disagreed about which emoji existed, and about which of
 * two presentations of the same emoji counted, so a reader could tap a glyph
 * the server then refused.
 */

import { describe, expect, it } from 'vitest';
import reactionsJson from './reactions.json';
import {
  REACTION_EMOJI,
  REACTION_LABELS,
  isAllowedReaction,
  normalizeReaction,
  reactionLabel,
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
      expect(isAllowedReaction(emoji)).toBe(true);
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

  it('accepts either presentation of the same emoji', () => {
    expect(isAllowedReaction('❤️')).toBe(true);
    expect(isAllowedReaction('❤')).toBe(true);
  });

  it('labels either presentation the same way', () => {
    expect(reactionLabel('❤️', 1)).toBe('Heart, 1 person');
    expect(reactionLabel('❤', 2)).toBe('Heart, 2 people');
  });

  it('still refuses an emoji that is on no list', () => {
    expect(isAllowedReaction('🦄')).toBe(false);
  });
});
