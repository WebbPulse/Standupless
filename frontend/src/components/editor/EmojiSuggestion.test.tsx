/**
 * The `:` shortcode emoji menu. A colon after a space and two shortcode
 * characters opens it under the caret, the arrows move the highlight, Enter or
 * Tab or a click inserts the emoji, Escape closes it for that colon and keeps
 * the text, and a closing colon on an exact shortcode inserts it directly.
 * Code, links, words and times never open it, and the emoji is stored as its
 * Unicode character so it round trips through the Markdown.
 */

import type { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  findShortcode,
  loadShortcodeCatalog,
  RECENT_EMOJI_STORAGE_KEY,
  type EmojiEntry,
} from '../../lib/emojiCatalog';
import { emojiQuery } from './EmojiSuggestion';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import { RichMarkdownEditor } from './RichMarkdownEditor';

let catalog: EmojiEntry[] = [];

beforeAll(async () => {
  catalog = await loadShortcodeCatalog();
});

/** The glyph a shortcode names in the loaded catalog. */
const glyph = (code: string): string => {
  const entry = findShortcode(catalog, code);
  if (entry === undefined) throw new Error(`no emoji for ${code}`);
  return entry.emoji;
};

/** The Tiptap editor behind a surface. */
const editorOf = (surface: HTMLElement): Editor =>
  (surface as HTMLElement & { editor: Editor }).editor;

/** Feeds text through the editor's own text input path, as typing does. */
const typeText = (editor: Editor, text: string): void => {
  act(() => {
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
  });
};

/** Renders an editable surface and answers its editor and change spy. */
const renderSurface = (): {
  surface: HTMLElement;
  editor: Editor;
  onChange: ReturnType<typeof vi.fn>;
} => {
  const onChange = vi.fn();
  render(
    <RichMarkdownEditor
      value=""
      editable
      ariaLabel="Description"
      onCommit={() => true}
      onChange={onChange}
    />
  );
  const surface = screen.getByRole('textbox', { name: 'Description' });
  const editor = editorOf(surface);
  act(() => {
    editor.commands.focus();
  });
  return { surface, editor, onChange };
};

/** The open emoji menu, or null. */
const menu = (): HTMLElement | null =>
  screen.queryByRole('listbox', { name: 'Insert an emoji' });

/** The shortcodes of the menu's rows, and which one is highlighted. */
const rows = (): { codes: string[]; selected: string | undefined } => {
  const open = menu();
  if (open === null) return { codes: [], selected: undefined };
  const options = within(open).getAllByRole('option');
  return {
    codes: options.map((option) => option.textContent),
    selected: options.find(
      (option) => option.getAttribute('aria-selected') === 'true'
    )?.textContent,
  };
};

/** Presses a key on the surface. */
const press = (surface: HTMLElement, key: string): void => {
  act(() => {
    fireEvent.keyDown(surface, { key });
  });
};

/** The last Markdown the surface reported. */
const lastMarkdown = (onChange: ReturnType<typeof vi.fn>): unknown =>
  onChange.mock.calls.at(-1)?.[0];

describe('the trigger', () => {
  it('needs a colon and two shortcode characters', () => {
    expect(emojiQuery(':r')).toBeNull();
    expect(emojiQuery(':ro')).toEqual({ start: 0, query: 'ro' });
    expect(emojiQuery('ship it :+1')).toEqual({ start: 8, query: '+1' });
  });

  it('opens at the start, after a space or after an opening bracket', () => {
    expect(emojiQuery('done :tada')?.query).toBe('tada');
    expect(emojiQuery('(:tada')?.query).toBe('tada');
    expect(emojiQuery('":tada')?.query).toBe('tada');
  });

  it('stays shut after a word, a time, a path or a second colon', () => {
    expect(emojiQuery('note:ta')).toBeNull();
    expect(emojiQuery('at 10:30')).toBeNull();
    expect(emojiQuery('https://example.com/:id')).toBeNull();
    expect(emojiQuery('::ta')).toBeNull();
    expect(emojiQuery(':tada ')).toBeNull();
  });
});

describe('the emoji menu', () => {
  it('opens on a shortcode and lists the closest match first', () => {
    const { editor } = renderSurface();
    typeText(editor, ':t');
    expect(menu()).toBeNull();
    typeText(editor, 'ada');
    expect(rows().selected).toContain(':tada:');
    expect(rows().selected).toContain(glyph('tada'));
    typeText(editor, 'zzzz');
    expect(menu()).toBeNull();
  });

  it('moves with the arrows and inserts the highlighted emoji on Enter', () => {
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, 'Looks :thumbs');
    expect(rows().codes.slice(0, 2)).toEqual([
      `${glyph('thumbsup')}:+1:`,
      `${glyph('thumbsdown')}:-1:`,
    ]);
    press(surface, 'ArrowDown');
    expect(rows().selected).toContain(':-1:');
    press(surface, 'ArrowUp');
    expect(rows().selected).toContain(':+1:');
    press(surface, 'ArrowUp');
    expect(rows().selected).not.toContain(':+1:');
    press(surface, 'ArrowDown');
    press(surface, 'ArrowDown');
    press(surface, 'Enter');
    expect(menu()).toBeNull();
    expect(lastMarkdown(onChange)).toBe(`Looks ${glyph('thumbsdown')}`);
  });

  it('inserts on Tab and on a click', () => {
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, ':rocket');
    press(surface, 'Tab');
    typeText(editor, ' and :tada');
    const row = within(menu() as HTMLElement).getAllByRole('option')[0];
    act(() => {
      fireEvent.mouseDown(row as HTMLElement);
    });
    expect(menu()).toBeNull();
    expect(lastMarkdown(onChange)).toBe(
      `${glyph('rocket')} and ${glyph('tada')}`
    );
  });

  it('ranks recently used emoji first', () => {
    const { surface, editor } = renderSurface();
    typeText(editor, ':thumbs');
    press(surface, 'ArrowDown');
    press(surface, 'Enter');
    expect(
      JSON.parse(
        globalThis.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY) ?? '[]'
      )
    ).toEqual([glyph('thumbsdown')]);
    typeText(editor, ' :thumbs');
    expect(rows().codes[0]).toContain(':-1:');
  });

  it('closes on Escape for that colon and keeps the text', () => {
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, ':tada');
    expect(menu()).not.toBeNull();
    press(surface, 'Escape');
    expect(menu()).toBeNull();
    typeText(editor, 'x');
    expect(menu()).toBeNull();
    expect(lastMarkdown(onChange)).toBe(':tadax');
    typeText(editor, ' :tada');
    expect(menu()).not.toBeNull();
  });

  it('inserts an exact shortcode on its closing colon', () => {
    const { editor, onChange } = renderSurface();
    typeText(editor, 'Shipped :tada:');
    expect(menu()).toBeNull();
    expect(lastMarkdown(onChange)).toBe(`Shipped ${glyph('tada')}`);
    typeText(editor, ' :nosuchemoji:');
    expect(lastMarkdown(onChange)).toBe(
      `Shipped ${glyph('tada')} :nosuchemoji:`
    );
  });

  it('stays shut after a word and inside code', () => {
    const { editor } = renderSurface();
    typeText(editor, 'at 10:30 and note:tada');
    expect(menu()).toBeNull();
    act(() => {
      editor.commands.toggleCode();
    });
    typeText(editor, ' :tada');
    expect(menu()).toBeNull();
    act(() => {
      editor.commands.setContent('');
      editor.commands.setCodeBlock();
    });
    typeText(editor, ':tada');
    expect(menu()).toBeNull();
  });

  it('stores the emoji as its character so it round trips', () => {
    const { editor, onChange } = renderSurface();
    typeText(editor, ':rocket:');
    const stored = lastMarkdown(onChange) as string;
    expect(stored).toBe(glyph('rocket'));
    act(() => {
      writeMarkdown(editor, `**Launch** ${stored}`);
    });
    expect(readMarkdown(editor)).toBe(`**Launch** ${stored}`);
  });
});
