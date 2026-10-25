/**
 * The reference chips the rich editor draws while editing. Covers that an
 * issue key of a known team and a link to a workspace page are marked for the
 * chip style, that other keys, other links and code stay plain, that a redraw
 * meta picks up a change in what counts as a reference, and that the stored
 * Markdown is untouched by the chips. With issue looks, a resolved key is
 * drawn with its status glyph and title, a key still unresolved stays plain,
 * and inline code holding only a key becomes a chip while other code stays
 * code.
 */

import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  issueKeysIn,
  markdownExtensions,
  referenceChipsKey,
  type IssueLook,
} from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';

const ORIGIN = 'https://app.example.com';
const PAGE = `${ORIGIN}/w/acme/projects/prj-1`;

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** An editor holding `source`, with ENG keys and acme pages as references. */
const open = (
  source: string,
  teams: { known: string[] } = { known: ['ENG'] }
) => {
  const made = new Editor({
    element: document.createElement('div'),
    extensions: markdownExtensions({
      isIssueKey: (key) => teams.known.includes(key.split('-')[0] ?? ''),
      isReferenceLink: (href) => href.startsWith(`${ORIGIN}/w/acme/`),
    }),
  });
  writeMarkdown(made, source);
  editor = made;
  return made;
};

/** The text of every chip the editor draws, in order. */
const chips = (made: Editor, selector = '.rich-reference'): string[] =>
  Array.from(made.view.dom.querySelectorAll(selector)).map(
    (node) => node.textContent ?? ''
  );

describe('reference chips while editing', () => {
  it('marks issue keys of a known team', () => {
    const made = open('Blocked on ENG-12 and ABC-3, see eng-4.');

    expect(chips(made, '.rich-issue-ref')).toEqual(['ENG-12']);
  });

  it('marks links to a workspace page and leaves other links plain', () => {
    const made = open(
      `Read [Roadmap](${PAGE}) and [Docs](https://elsewhere.example.com/x).`
    );

    expect(chips(made)).toEqual(['Roadmap']);
    expect(chips(made, '.rich-issue-ref')).toEqual([]);
  });

  it('leaves keys inside code alone', () => {
    const made = open('Run `ENG-12` now');

    expect(chips(made)).toEqual([]);
  });

  it('redraws when what counts as a team changes', () => {
    const teams = { known: [] as string[] };
    const made = open('Fixes ENG-12', teams);
    expect(chips(made)).toEqual([]);

    teams.known.push('ENG');
    made.view.dispatch(made.state.tr.setMeta(referenceChipsKey, true));

    expect(chips(made)).toEqual(['ENG-12']);
  });

  it('keeps the stored Markdown exactly as written', () => {
    const source = `Fixes ENG-12, see [Roadmap](${PAGE})`;
    const made = open(source);

    expect(readMarkdown(made)).toBe(source);
  });
});

/** An editor holding `source` whose ENG keys resolve to the looks in `looks`. */
const openWithLooks = (source: string, looks: Map<string, IssueLook>) => {
  const made = new Editor({
    element: document.createElement('div'),
    extensions: markdownExtensions({
      isIssueKey: (key) => key.startsWith('ENG-'),
      issueLook: (key) => looks.get(key),
    }),
  });
  writeMarkdown(made, source);
  editor = made;
  return made;
};

/** A look whose glyph is a marked svg, so a test can find the clone. */
const lookOf = (title: string): IssueLook => {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('data-glyph', title);
  return { title, icon, signature: title };
};

describe('issue mention chips while editing', () => {
  it('draws a resolved key with its glyph, muted key and title', () => {
    const made = openWithLooks(
      'Blocked on ENG-12 today',
      new Map([['ENG-12', lookOf('Ship the importer')]])
    );

    expect(chips(made, '.rich-issue-chip')).toEqual(['ENG-12']);
    expect(chips(made, '.rich-issue-title')).toEqual(['Ship the importer']);
    const icon = made.view.dom.querySelector('.rich-issue-icon');
    expect(icon?.getAttribute('data-issue-key')).toBe('ENG-12');
    expect(icon?.querySelector('[data-glyph]')).not.toBeNull();
    expect(readMarkdown(made)).toBe('Blocked on ENG-12 today');
  });

  it('leaves a key that has not resolved as plain text', () => {
    const made = openWithLooks('Blocked on ENG-12', new Map());

    expect(chips(made, '.rich-issue-ref')).toEqual([]);
  });

  it('draws inline code holding only a key as a chip', () => {
    const made = openWithLooks(
      'See `ENG-12` and `npm run ENG-12`',
      new Map([['ENG-12', lookOf('Ship the importer')]])
    );

    expect(chips(made, 'code .rich-issue-chip')).toEqual(['ENG-12']);
    expect(chips(made, '.rich-issue-title')).toEqual(['Ship the importer']);
    expect(readMarkdown(made)).toBe('See `ENG-12` and `npm run ENG-12`');
  });

  it('draws the chip once a look arrives and the chips redraw', () => {
    const looks = new Map<string, IssueLook>();
    const made = openWithLooks('Fixes ENG-12', looks);
    expect(chips(made, '.rich-issue-chip')).toEqual([]);

    looks.set('ENG-12', lookOf('Ship the importer'));
    made.view.dispatch(made.state.tr.setMeta(referenceChipsKey, true));

    expect(chips(made, '.rich-issue-chip')).toEqual(['ENG-12']);
  });

  it('lists the keys a document mentions, each once', () => {
    const made = openWithLooks(
      `ENG-1, \`ENG-2\`, ENG-1, ABC-3, [ENG-4](${PAGE}) and \`run ENG-5\``,
      new Map()
    );

    expect(
      issueKeysIn(made.state.doc, (key) => key.startsWith('ENG-'))
    ).toEqual(['ENG-1', 'ENG-2']);
  });
});
