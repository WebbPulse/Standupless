/** The resolved thread summary's excerpt and reply count wording. */

import { describe, expect, it } from 'vitest';
import { commentExcerpt, replyCountLabel } from './threadResolution';

describe('thread resolution summary', () => {
  it('takes the first non-empty line as plain text', () => {
    expect(
      commentExcerpt('\n## **Should** we ship [this](https://x.test)?\nMore')
    ).toBe('Should we ship this?');
  });

  it('drops images and code fences', () => {
    expect(commentExcerpt('![shot](a.png)\n```\ncode\n```\nThe rest')).toBe(
      'The rest'
    );
  });

  it('shortens a long first line with an ellipsis', () => {
    const excerpt = commentExcerpt('a'.repeat(300));
    expect(excerpt).toHaveLength(120);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('is empty for a comment with only an attachment', () => {
    expect(commentExcerpt('')).toBe('');
  });

  it('counts replies', () => {
    expect(replyCountLabel(0)).toBe('');
    expect(replyCountLabel(1)).toBe('1 reply');
    expect(replyCountLabel(4)).toBe('4 replies');
  });
});
