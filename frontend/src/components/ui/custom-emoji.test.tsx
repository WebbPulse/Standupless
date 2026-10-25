/**
 * Custom emoji drawing: a known `:name:` in text or a reaction draws its
 * image with the shortcode as its text alternative, and one the workspace no
 * longer has stays as its `:name:` text.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { publishCustomEmoji, splitCustomEmoji } from '../../lib/customEmoji';
import { reactionLabel } from '../../lib/reactions';
import type { CustomEmojiRead } from '../../types/Api';
import { EmojiText, ReactionEmoji } from './custom-emoji';

const shipIt: CustomEmojiRead = {
  name: 'ship-it',
  shortcode: ':ship-it:',
  url: 'https://api.example.test/api/icons/emoji/ws/1',
  created_by: 'u-1',
  created_by_name: 'Ada',
  created_at: '2026-10-24T00:00:00Z',
};

afterEach(() => {
  act(() => {
    publishCustomEmoji([]);
  });
});

describe('splitCustomEmoji', () => {
  it('splits only the names the set holds', () => {
    const set = new Map([[shipIt.name, shipIt]]);
    expect(splitCustomEmoji('go :ship-it: now :gone:', set)).toEqual([
      'go ',
      shipIt,
      ' now :gone:',
    ]);
  });

  it('leaves text whole with an empty set', () => {
    expect(splitCustomEmoji('go :ship-it:', new Map())).toEqual([
      'go :ship-it:',
    ]);
  });
});

describe('EmojiText', () => {
  it('draws a known emoji as its image', () => {
    publishCustomEmoji([shipIt]);
    render(<EmojiText value="go :ship-it:" />);
    const image = screen.getByRole('img', { name: ':ship-it:' });
    expect(image.getAttribute('src')).toBe(shipIt.url);
  });

  it('falls back to the name once the emoji is deleted', () => {
    publishCustomEmoji([shipIt]);
    const { container } = render(<EmojiText value="go :ship-it:" />);
    act(() => {
      publishCustomEmoji([]);
    });
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).toBe('go :ship-it:');
  });
});

describe('ReactionEmoji', () => {
  it('draws a custom reaction as its image and a Unicode one as text', () => {
    publishCustomEmoji([shipIt]);
    const { container } = render(
      <>
        <ReactionEmoji emoji=":ship-it:" />
        <ReactionEmoji emoji="🚀" />
      </>
    );
    expect(screen.getByRole('img', { name: ':ship-it:' })).toBeTruthy();
    expect(container.textContent).toBe('🚀');
  });

  it('names a custom reaction by its shortcode', () => {
    expect(reactionLabel(':ship-it:', 2)).toBe(':ship-it:, 2 people');
  });
});
