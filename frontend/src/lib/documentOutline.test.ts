/**
 * The outline reads H1 to H3 in order, drops deeper headings and the ones
 * inside fenced code, and shows a heading's text without its Markdown.
 */

import { describe, expect, it } from 'vitest';
import { outlineOf } from './documentOutline';

describe('outlineOf', () => {
  it('lists H1 to H3 headings in order with their positions', () => {
    const markdown = '# Goal\n\nText\n\n## Plan\n\n#### Detail\n\n### Risks ##';
    expect(outlineOf(markdown)).toEqual([
      { level: 1, text: 'Goal', index: 0 },
      { level: 2, text: 'Plan', index: 1 },
      { level: 3, text: 'Risks', index: 2 },
    ]);
  });

  it('skips headings inside fenced code', () => {
    const markdown = '```sh\n# not a heading\n```\n\n## Real';
    expect(outlineOf(markdown)).toEqual([{ level: 2, text: 'Real', index: 0 }]);
  });

  it('reads a heading without its inline Markdown', () => {
    expect(
      outlineOf('## Ship **v2** with [docs](https://x.test) and `api`')
    ).toEqual([{ level: 2, text: 'Ship v2 with docs and api', index: 0 }]);
  });

  it('needs a space after the marks', () => {
    expect(outlineOf('#hashtag\n\n#')).toEqual([]);
  });
});
