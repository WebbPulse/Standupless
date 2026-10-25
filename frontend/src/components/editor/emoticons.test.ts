/**
 * Emoticon conversion in a live editor: a known emoticon followed by a space
 * or punctuation becomes its emoji, never inside code or a link or after a
 * word, Undo and Backspace right after bring the typed text back, and nothing
 * converts while the preference is off.
 */

import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, setPreferences } from '../../lib/preferences';
import { EMOTICONS, emoticonAt } from './emoticons';
import { markdownExtensions } from './markdownExtensions';
import { writeMarkdown } from './markdownCodec';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  setPreferences(DEFAULT_PREFERENCES);
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source, the caret at the end. */
const mounted = (source = ''): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, source);
  editor.commands.focus('end');
  return editor;
};

/** Puts the caret at a document position. */
const caretAt = (editor: Editor, position: number): void => {
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, position)
    )
  );
};

/** Feeds text through the editor's own text input path, as typing does. */
const typeText = (editor: Editor, text: string): void => {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', (handle) =>
      handle(editor.view, from, to, char, () =>
        editor.state.tr.insertText(char)
      )
    );
    if (handled !== true) {
      editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  }
};

/** Presses a key through the editor's key handlers, as the keyboard does. */
const press = (editor: Editor, key: string): void => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event));
};

/** The document's text. */
const text = (editor: Editor): string => editor.state.doc.textContent;

describe('the emoticon match', () => {
  it('needs a known emoticon at a boundary and a trigger after it', () => {
    expect(emoticonAt('hi :) ')?.text).toBe(':) ');
    expect(emoticonAt('<3!')?.text).toBe('<3!');
    expect(emoticonAt('(:D,')?.text).toBe(':D,');
    expect(emoticonAt('hi :)')).toBeNull();
    expect(emoticonAt('a:) ')).toBeNull();
    expect(emoticonAt('http:/')).toBeNull();
    expect(emoticonAt('at 10:30 ')).toBeNull();
    expect(emoticonAt(':Path ')).toBeNull();
  });
});

describe('typing an emoticon', () => {
  it('turns each listed emoticon into its emoji', () => {
    for (const [emoticon, emoji] of Object.entries(EMOTICONS)) {
      const editor = mounted();
      typeText(editor, `ok ${emoticon} `);
      expect(text(editor)).toBe(`ok ${emoji} `);
    }
  });

  it('keeps the punctuation that triggered it', () => {
    const editor = mounted();
    typeText(editor, 'thanks :D.');
    expect(text(editor)).toBe(`thanks ${EMOTICONS[':D']}.`);
  });

  it('brings the typed text back on Undo right after', () => {
    const editor = mounted();
    typeText(editor, 'hi <3 ');
    expect(text(editor)).toBe(`hi ${EMOTICONS['<3']} `);
    editor.commands.undo();
    expect(text(editor)).toBe('hi <3');
  });

  it('brings the typed text back on Backspace right after', () => {
    const editor = mounted();
    typeText(editor, 'hi :( ');
    press(editor, 'Backspace');
    expect(text(editor)).toBe('hi :( ');
  });

  it('leaves inline code alone', () => {
    const editor = mounted('`code`');
    caretAt(editor, 3);
    typeText(editor, ' :) ');
    expect(text(editor)).toBe('co :) de');
  });

  it('leaves code blocks alone', () => {
    const editor = mounted('```\nx\n```');
    caretAt(editor, 2);
    typeText(editor, ' :) ');
    expect(text(editor)).toBe('x :) ');
  });

  it('leaves links alone', () => {
    const editor = mounted('[site](https://example.com)');
    caretAt(editor, 3);
    typeText(editor, ' :) ');
    expect(text(editor)).toBe('si :) te');
  });

  it('converts nothing while the preference is off', () => {
    setPreferences({ ...DEFAULT_PREFERENCES, convertEmoticons: false });
    const editor = mounted();
    typeText(editor, 'hi :) <3 ');
    expect(text(editor)).toBe('hi :) <3 ');
  });
});
