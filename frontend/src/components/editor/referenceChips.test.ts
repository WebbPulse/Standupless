/**
 * The reference chips the rich editor draws while editing. Covers that an
 * issue key of a known team and a link to a workspace page are marked for the
 * chip style, that other keys, other links and code stay plain, that a redraw
 * meta picks up a change in what counts as a reference, and that the stored
 * Markdown is untouched by the chips. With issue looks, a resolved key is
 * drawn as one inline chip with its status glyph, key and title over the
 * hidden key, a key still unresolved stays plain, and inline code holding
 * only a key becomes a chip while other code stays code. The chip is an atom:
 * the arrow keys step over it, Backspace and Delete remove it whole, the
 * caret never rests inside its key, a word typed against it keeps a space
 * between, and a key still being typed stays text until the caret leaves.
 */

import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
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
  it('draws a resolved key as one inline chip with its glyph, key and title', () => {
    const made = openWithLooks(
      'Blocked on ENG-12 today',
      new Map([['ENG-12', lookOf('Ship the importer')]])
    );

    const drawn = made.view.dom.querySelectorAll('.rich-issue-chip');
    expect(drawn).toHaveLength(1);
    const chip = drawn[0] as HTMLElement;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.parentElement?.tagName).toBe('P');
    expect(chip.getAttribute('data-issue-key')).toBe('ENG-12');
    expect(chip.getAttribute('contenteditable')).toBe('false');
    expect(chip.textContent).toBe('ENG-12Ship the importer');
    expect(
      Array.from(chip.childNodes).map((node) => (node as Element).className)
    ).toEqual(['rich-issue-icon', 'rich-issue-key', 'rich-issue-title']);
    expect(
      chip.querySelector('.rich-issue-icon [data-glyph]')
    ).not.toBeNull();
    expect(chips(made, '.rich-issue-source')).toEqual(['ENG-12']);
    expect(chip.nextElementSibling?.className).toBe('rich-issue-source');
    expect(chip.previousSibling?.textContent).toBe('Blocked on ');
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

    expect(chips(made, 'code .rich-issue-source')).toEqual(['ENG-12']);
    expect(chips(made, '.rich-issue-title')).toEqual(['Ship the importer']);
    expect(
      made.view.dom.querySelector('.rich-issue-chip')?.closest('code')
    ).toBeNull();
    expect(readMarkdown(made)).toBe('See `ENG-12` and `npm run ENG-12`');
  });

  it('draws the chip once a look arrives and the chips redraw', () => {
    const looks = new Map<string, IssueLook>();
    const made = openWithLooks('Fixes ENG-12', looks);
    expect(chips(made, '.rich-issue-key')).toEqual([]);

    looks.set('ENG-12', lookOf('Ship the importer'));
    made.view.dispatch(made.state.tr.setMeta(referenceChipsKey, true));

    expect(chips(made, '.rich-issue-key')).toEqual(['ENG-12']);
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

/** Puts the caret at `position`. */
const caretAt = (made: Editor, position: number): void => {
  made.view.dispatch(
    made.state.tr.setSelection(TextSelection.create(made.state.doc, position))
  );
};

/** Presses `key` through the editor's own key handling, returning whether it was handled. */
const press = (made: Editor, key: string, shiftKey = false): boolean =>
  made.view.someProp('handleKeyDown', (handle) =>
    handle(made.view, new KeyboardEvent('keydown', { key, shiftKey }))
  ) === true;

/** Types `text` at the caret through the editor's text input path. */
const typeAt = (made: Editor, text: string): void => {
  const { from, to } = made.state.selection;
  const handled = made.view.someProp('handleTextInput', (handle) =>
    handle(made.view, from, to, text, () => made.state.tr.insertText(text))
  );
  if (handled !== true) {
    made.view.dispatch(made.state.tr.insertText(text, from, to));
  }
};

describe('issue mention chips as atoms', () => {
  const SOURCE = 'Blocked on ENG-12 today';
  const START = 12;
  const END = 18;
  const resolved = () =>
    openWithLooks(SOURCE, new Map([['ENG-12', lookOf('Ship the importer')]]));

  it('steps the caret over the chip with the arrow keys', () => {
    const made = resolved();
    caretAt(made, START);

    expect(press(made, 'ArrowRight')).toBe(true);
    expect(made.state.selection.head).toBe(END);

    expect(press(made, 'ArrowLeft')).toBe(true);
    expect(made.state.selection.head).toBe(START);
  });

  it('extends a selection over the whole chip with Shift', () => {
    const made = resolved();
    caretAt(made, START);

    press(made, 'ArrowRight', true);

    expect(made.state.selection.from).toBe(START);
    expect(made.state.selection.to).toBe(END);
  });

  it('never leaves the caret inside the hidden key', () => {
    const made = resolved();
    caretAt(made, START);

    caretAt(made, START + 2);
    expect(made.state.selection.head).toBe(END);

    caretAt(made, END - 1);
    expect(made.state.selection.head).toBe(START);
  });

  it('removes the whole chip with Backspace after it and Delete before it', () => {
    const made = resolved();
    caretAt(made, END);
    expect(press(made, 'Backspace')).toBe(true);
    expect(readMarkdown(made)).toBe('Blocked on  today');

    const again = resolved();
    caretAt(again, START);
    expect(press(again, 'Delete')).toBe(true);
    expect(readMarkdown(again)).toBe('Blocked on  today');
  });

  it('keeps a word typed against the chip a space apart, and punctuation tight', () => {
    const made = resolved();
    caretAt(made, END);
    typeAt(made, 's');
    expect(readMarkdown(made)).toBe('Blocked on ENG-12 s today');

    const before = resolved();
    caretAt(before, START);
    typeAt(before, 'x');
    expect(readMarkdown(before)).toBe('Blocked on x ENG-12 today');
    expect(before.state.selection.head).toBe(START + 1);

    const tight = resolved();
    caretAt(tight, END);
    typeAt(tight, ',');
    expect(readMarkdown(tight)).toBe('Blocked on ENG-12, today');
    expect(chips(tight, '.rich-issue-key')).toEqual(['ENG-12']);
  });

  it('leaves a key being typed as text until the caret moves on', () => {
    const made = openWithLooks(
      'See',
      new Map([
        ['ENG-1', lookOf('First')],
        ['ENG-12', lookOf('Twelfth')],
      ])
    );
    caretAt(made, 4);

    typeAt(made, ' ENG-1');
    expect(chips(made, '.rich-issue-key')).toEqual([]);
    typeAt(made, '2');
    expect(chips(made, '.rich-issue-key')).toEqual([]);
    expect(readMarkdown(made)).toBe('See ENG-12');

    typeAt(made, ' ');
    expect(chips(made, '.rich-issue-key')).toEqual(['ENG-12']);
  });

  it('draws a key typed earlier once the caret leaves its end', () => {
    const made = openWithLooks('See', new Map([['ENG-12', lookOf('Twelfth')]]));
    caretAt(made, 4);
    typeAt(made, ' ENG-12');
    expect(chips(made, '.rich-issue-key')).toEqual([]);

    caretAt(made, 1);

    expect(chips(made, '.rich-issue-key')).toEqual(['ENG-12']);
  });
});
