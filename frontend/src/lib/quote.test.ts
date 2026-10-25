/**
 * Quoting into a reply. Covers that a passage becomes one blockquote with
 * every line marked, and that a rendered passage reads back into the Markdown
 * that draws it: chips by the source they carry, links by their address,
 * marks, line breaks and list items kept, and controls left out.
 */

import { describe, expect, it } from 'vitest';
import { fragmentMarkdown, quoteMarkdown, rangeMarkdown } from './quote';

/** A rendered passage as a detached element. */
const rendered = (html: string): HTMLElement => {
  const node = document.createElement('div');
  node.innerHTML = html;
  return node;
};

describe('quoteMarkdown', () => {
  it('marks every line of a passage as quoted', () => {
    expect(quoteMarkdown('First line\nSecond line')).toBe(
      '> First line\n> Second line'
    );
  });

  it('keeps a blank line inside the quote', () => {
    expect(quoteMarkdown('One\n\nTwo')).toBe('> One\n>\n> Two');
  });

  it('trims the passage and quotes empty text as nothing', () => {
    expect(quoteMarkdown('\n  Hello  \n')).toBe('> Hello');
    expect(quoteMarkdown('   ')).toBe('');
  });

  it('keeps mentions, issue keys and links as written', () => {
    expect(
      quoteMarkdown('@ada see STUP-12 and [the doc](https://x.dev/d)')
    ).toBe('> @ada see STUP-12 and [the doc](https://x.dev/d)');
  });
});

describe('fragmentMarkdown', () => {
  it('reads a mention chip back as its handle', () => {
    expect(
      fragmentMarkdown(
        rendered('<p>Ask <span data-md="@ada">@Ada Lovelace</span> first</p>')
      )
    ).toBe('Ask @ada first');
  });

  it('reads an issue chip back as its key', () => {
    expect(
      fragmentMarkdown(
        rendered(
          '<p>See <a href="/w/issue/STUP-12" data-md="STUP-12"><svg></svg><span>STUP-12</span><span>Fix login</span></a></p>'
        )
      )
    ).toBe('See STUP-12');
  });

  it('reads a link back with its address', () => {
    expect(
      fragmentMarkdown(
        rendered('<p>Read <a href="https://x.dev/d">the doc</a> now</p>')
      )
    ).toBe('Read [the doc](https://x.dev/d) now');
  });

  it('reads a reference chip back as the link it was written as', () => {
    expect(
      fragmentMarkdown(
        rendered(
          '<p><a href="/w/projects/p1" data-md-href="https://standupless.dev/w/projects/p1">Launch</a></p>'
        )
      )
    ).toBe('[Launch](https://standupless.dev/w/projects/p1)');
  });

  it('writes a bare address for a link whose text is its address', () => {
    expect(
      fragmentMarkdown(
        rendered('<p><a href="https://x.dev">https://x.dev</a></p>')
      )
    ).toBe('https://x.dev');
  });

  it('keeps marks, breaks and separate blocks', () => {
    expect(
      fragmentMarkdown(
        rendered(
          '<p><strong>Bold</strong> and <em>soft</em> and <code>x()</code><br>next</p><p>Second</p>'
        )
      )
    ).toBe('**Bold** and _soft_ and `x()`\nnext\n\nSecond');
  });

  it('keeps list items as a list', () => {
    expect(
      fragmentMarkdown(rendered('<ul><li><p>One</p></li><li>Two</li></ul>'))
    ).toBe('- One\n- Two');
  });

  it('leaves out buttons and hidden decoration', () => {
    expect(
      fragmentMarkdown(
        rendered(
          '<p>Text<button>Copy</button><span aria-hidden="true">x</span></p>'
        )
      )
    ).toBe('Text');
  });

  it('reads only the selected part of a passage', () => {
    const node = rendered('<p>Looks good to me</p>');
    document.body.append(node);
    const text = node.querySelector('p')?.firstChild;
    if (text === null || text === undefined) throw new Error('no text');
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    expect(rangeMarkdown(range)).toBe('good');
    node.remove();
  });
});
