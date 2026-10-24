/**
 * The `/` insert menu inside a live surface. Typing a slash opens it under
 * the caret, more letters narrow it, the arrows move the highlight and wrap,
 * Enter or a click inserts the block in place of what was typed, and Escape
 * closes it for that slash without touching the text.
 */

import type { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RichMarkdownEditor } from './RichMarkdownEditor';

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

/** The open insert menu, or null. */
const menu = (): HTMLElement | null =>
  screen.queryByRole('listbox', { name: 'Insert a block' });

/** The labels of the menu's rows, and which one is highlighted. */
const rows = (): { labels: string[]; selected: string | undefined } => {
  const open = menu();
  if (open === null) return { labels: [], selected: undefined };
  const options = within(open).getAllByRole('option');
  return {
    labels: options.map((option) => option.textContent),
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

describe('the slash menu', () => {
  it('opens on a slash and narrows as the query grows', () => {
    const { editor } = renderSurface();
    typeText(editor, '/');
    expect(rows().labels.length).toBeGreaterThan(5);
    expect(rows().selected).toContain('Heading 1');
    typeText(editor, 'hea');
    expect(rows().labels).toEqual([
      'Heading 1#',
      'Heading 2##',
      'Heading 3###',
    ]);
    typeText(editor, 'zz');
    expect(menu()).toBeNull();
  });

  it('moves the highlight with the arrows, wrapping, and inserts on Enter', () => {
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, '/head');
    press(surface, 'ArrowDown');
    expect(rows().selected).toContain('Heading 2');
    press(surface, 'ArrowUp');
    press(surface, 'ArrowUp');
    expect(rows().selected).toContain('Heading 3');
    press(surface, 'Enter');
    expect(menu()).toBeNull();
    typeText(editor, 'Plan');
    expect(lastMarkdown(onChange)).toBe('### Plan');
  });

  it('inserts the clicked row', () => {
    const { editor, onChange } = renderSurface();
    typeText(editor, 'Note /');
    const quote = within(menu() as HTMLElement).getByRole('option', {
      name: /Quote/,
    });
    act(() => {
      fireEvent.mouseDown(quote);
    });
    expect(menu()).toBeNull();
    typeText(editor, 'Plan');
    expect(lastMarkdown(onChange)).toBe('> Note Plan');
  });

  it('closes on Escape for that slash and keeps the text', () => {
    const { surface, editor, onChange } = renderSurface();
    typeText(editor, '/');
    expect(menu()).not.toBeNull();
    press(surface, 'Escape');
    expect(menu()).toBeNull();
    typeText(editor, 'h');
    expect(menu()).toBeNull();
    expect(lastMarkdown(onChange)).toBe('/h');
    typeText(editor, ' /');
    expect(menu()).not.toBeNull();
  });

  it('stays shut for a slash inside a word', () => {
    const { editor } = renderSurface();
    typeText(editor, 'src/');
    expect(menu()).toBeNull();
  });
});
