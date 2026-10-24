/**
 * The reference chips the rich editor draws while editing. Covers that an
 * issue key of a known team and a link to a workspace page are marked for the
 * chip style, that other keys, other links and code stay plain, that a redraw
 * meta picks up a change in what counts as a reference, and that the stored
 * Markdown is untouched by the chips.
 */

import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownExtensions, referenceChipsKey } from './markdownExtensions';
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
