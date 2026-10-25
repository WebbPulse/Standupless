/**
 * Comment anchors in the rich editor. Covers reading a document as the plain
 * text passages are matched in, telling repeats of a quote apart by their
 * surroundings, capturing a selection with its context, drawing the passages
 * of open threads as highlights that report which were found, and that the
 * stored Markdown is untouched by them.
 */

import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANCHOR_QUOTE_MAX,
  capturePassage,
  commentAnchorsKey,
  commentAnchorsPlugin,
  flatten,
  locatePassage,
} from './commentAnchors';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** An editor holding `source`. */
const open = (source: string): Editor => {
  const made = new Editor({
    element: document.createElement('div'),
    extensions: markdownExtensions(),
  });
  writeMarkdown(made, source);
  editor = made;
  return made;
};

/** The document positions that hold `needle`, as a from and to pair. */
const rangeOf = (made: Editor, needle: string): [number, number] => {
  const { text, positions } = flatten(made.state.doc);
  const start = text.indexOf(needle);
  const from = positions[start] ?? -1;
  const last = positions[start + needle.length - 1] ?? -1;
  return [from, last + 1];
};

describe('flatten', () => {
  it('reads blocks as lines and drops inline marks', () => {
    const made = open('First **bold** line\n\n- one\n- two');
    expect(flatten(made.state.doc).text).toBe('First bold line\none\ntwo');
  });
});

describe('locatePassage', () => {
  it('finds a quote that appears once', () => {
    expect(locatePassage('cache the board query', { quote: 'board' })).toEqual({
      start: 10,
      end: 15,
    });
  });

  it('keeps the repeat whose surroundings match', () => {
    const text = 'the query is slow. the query is fast.';
    expect(
      locatePassage(text, {
        quote: 'the query',
        prefix: 'slow. ',
        suffix: ' is f',
      })
    ).toEqual({ start: 19, end: 28 });
    expect(
      locatePassage(text, { quote: 'the query', prefix: '', suffix: ' is s' })
    ).toEqual({ start: 0, end: 9 });
  });

  it('finds nothing once the text is edited away', () => {
    expect(locatePassage('cache the list', { quote: 'board query' })).toBe(
      null
    );
  });
});

describe('capturePassage', () => {
  it('takes the selected text with the text either side', () => {
    const made = open('Please cache the board query today.');
    const [from, to] = rangeOf(made, 'board query');
    expect(capturePassage(made.state.doc, from, to)).toEqual({
      quote: 'board query',
      prefix: 'Please cache the ',
      suffix: ' today.',
    });
  });

  it('spans blocks as lines and trims the edges', () => {
    const made = open('One two\n\nthree four');
    const [from] = rangeOf(made, 'two');
    const [, to] = rangeOf(made, 'three');
    expect(capturePassage(made.state.doc, from, to)?.quote).toBe('two\nthree');
  });

  it('caps a long passage', () => {
    const made = open('word '.repeat(400));
    const doc = made.state.doc;
    const quote = capturePassage(doc, 0, doc.content.size)?.quote ?? '';
    expect(quote.length).toBeLessThanOrEqual(ANCHOR_QUOTE_MAX);
    expect(quote.startsWith('word word')).toBe(true);
  });

  it('holds nothing for an empty selection', () => {
    const made = open('Text');
    expect(capturePassage(made.state.doc, 1, 1)).toBe(null);
  });
});

describe('the highlight plugin', () => {
  it('draws found passages and reports which threads were found', () => {
    const made = open('Please cache the **board** query today.');
    const onLocated = vi.fn();
    made.registerPlugin(commentAnchorsPlugin(onLocated));
    made.view.dispatch(
      made.state.tr.setMeta(commentAnchorsKey, {
        threads: [
          { commentId: 'c-1', anchor: { quote: 'board query' } },
          { commentId: 'c-2', anchor: { quote: 'gone text' } },
        ],
        activeId: 'c-1',
      })
    );
    const marks = Array.from(
      made.view.dom.querySelectorAll('[data-comment-anchor="c-1"]')
    );
    expect(marks.map((node) => node.textContent).join('')).toBe('board query');
    expect(marks[0]?.classList.contains('comment-anchor-active')).toBe(true);
    expect(onLocated).toHaveBeenLastCalledWith(['c-1']);
    expect(readMarkdown(made)).toBe('Please cache the **board** query today.');
  });

  it('reports a passage lost once an edit removes it', () => {
    const made = open('Please cache the board query today.');
    const onLocated = vi.fn();
    made.registerPlugin(commentAnchorsPlugin(onLocated));
    made.view.dispatch(
      made.state.tr.setMeta(commentAnchorsKey, {
        threads: [{ commentId: 'c-1', anchor: { quote: 'board query' } }],
        activeId: null,
      })
    );
    expect(onLocated).toHaveBeenLastCalledWith(['c-1']);
    writeMarkdown(made, 'Please cache the list today.');
    expect(onLocated).toHaveBeenLastCalledWith([]);
  });
});
