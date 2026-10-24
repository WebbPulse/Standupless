/**
 * Holds the selection toolbar and the formatting chords to the Markdown they
 * write. Each button formats the selected text into the same stored text the
 * Markdown shortcut would, shows when its formatting is already on, and names
 * its keys; the chords Linear users expect reach the same formatting.
 */

import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORMAT_ACTIONS,
  actionTooltip,
  shortcutLabel,
  shouldShowToolbar,
} from './formatting';
import { FormattingButtons } from './FormattingToolbar';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source, with all its text selected. */
const editorWith = (source: string): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, source);
  editor.commands.setTextSelection({
    from: 1,
    to: editor.state.doc.content.size - 1,
  });
  return editor;
};

/** The toolbar's buttons over an editor, with a spy for the link field. */
const renderButtons = (editor: Editor): { openLink: () => void } => {
  const openLink = vi.fn();
  render(<FormattingButtons editor={editor} context={{ openLink }} />);
  return { openLink };
};

const WRITES: [string, string][] = [
  ['bold', '**word**'],
  ['italic', '*word*'],
  ['strike', '~~word~~'],
  ['code', '`word`'],
  ['heading1', '# word'],
  ['heading2', '## word'],
  ['heading3', '### word'],
  ['bulletList', '- word'],
  ['orderedList', '1. word'],
  ['taskList', '- [ ] word'],
  ['blockquote', '> word'],
  ['codeBlock', '```\nword\n```'],
];

describe('the formatting toolbar', () => {
  it('offers every action as a labelled button', () => {
    renderButtons(editorWith('word'));
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    for (const action of FORMAT_ACTIONS) {
      expect(
        toolbar.querySelector(`[data-action="${action.id}"]`)
      ).toHaveAccessibleName(action.label);
    }
  });

  it.each(WRITES)('writes %s as the Markdown shortcut would', (id, written) => {
    const editor = editorWith('word');
    renderButtons(editor);
    const button = document.querySelector(`[data-action="${id}"]`);
    expect(button).not.toBeNull();
    expect(button).toHaveAttribute('aria-pressed', 'false');
    act(() => {
      fireEvent.click(button as HTMLElement);
    });
    expect(readMarkdown(editor)).toBe(written);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    writeMarkdown(editor, written);
    expect(readMarkdown(editor)).toBe(written);
  });

  it('opens the link field for a link', () => {
    const editor = editorWith('word');
    const { openLink } = renderButtons(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(readMarkdown(editor)).toBe('word');
  });

  it('shows formatting already on as pressed', () => {
    renderButtons(editorWith('**word**'));
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('keeps focus in the document when a button is pressed', () => {
    renderButtons(editorWith('word'));
    const pressed = fireEvent.mouseDown(
      screen.getByRole('button', { name: 'Bold' })
    );
    expect(pressed).toBe(false);
  });
});

describe('shortcut labels', () => {
  it('runs symbols together on Apple platforms', () => {
    expect(shortcutLabel(['mod', 'shift', '\\'], true)).toBe('⌘⇧\\');
    expect(shortcutLabel(['mod', 'alt', '1'], true)).toBe('⌘⌥1');
  });

  it('joins names with plus signs elsewhere', () => {
    expect(shortcutLabel(['mod', 'e'], false)).toBe('Ctrl+E');
    expect(shortcutLabel(['mod', 'shift', 's'], false)).toBe('Ctrl+Shift+S');
  });

  it('names the keys in each tooltip', () => {
    const bold = FORMAT_ACTIONS.find((action) => action.id === 'bold');
    expect(bold).toBeDefined();
    expect(actionTooltip(bold as (typeof FORMAT_ACTIONS)[number], false)).toBe(
      'Bold  Ctrl+B'
    );
  });
});

describe('when the toolbar shows', () => {
  it('shows over selected text in a focused, editable surface', () => {
    const editor = editorWith('word');
    expect(shouldShowToolbar(editor, editor.state, true)).toBe(true);
    expect(shouldShowToolbar(editor, editor.state, false)).toBe(false);
  });

  it('stays hidden for a caret, read only text and code blocks', () => {
    const editor = editorWith('word');
    const caret = editor.state.apply(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2))
    );
    expect(shouldShowToolbar(editor, caret, true)).toBe(false);
    editor.setEditable(false);
    expect(shouldShowToolbar(editor, editor.state, true)).toBe(false);
    editor.setEditable(true);
    const code = editorWith('```\nword\n```');
    expect(shouldShowToolbar(code, code.state, true)).toBe(false);
  });
});

describe('formatting chords', () => {
  /** Presses a chord on the document, as the keyboard would. */
  const press = (
    editor: Editor,
    init: KeyboardEventInit & { keyCode?: number }
  ): void => {
    act(() => {
      fireEvent.keyDown(editor.view.dom, init);
    });
  };

  it('formats inline code on Ctrl+E', () => {
    const editor = editorWith('word');
    press(editor, { key: 'e', code: 'KeyE', keyCode: 69, ctrlKey: true });
    expect(readMarkdown(editor)).toBe('`word`');
  });

  it('makes a code block on Ctrl+Shift+Backslash', () => {
    const editor = editorWith('word');
    press(editor, {
      key: '|',
      code: 'Backslash',
      keyCode: 220,
      ctrlKey: true,
      shiftKey: true,
    });
    expect(readMarkdown(editor)).toBe('```\nword\n```');
  });

  it('makes a code block on Ctrl+Alt+C', () => {
    const editor = editorWith('word');
    press(editor, {
      key: 'c',
      code: 'KeyC',
      keyCode: 67,
      ctrlKey: true,
      altKey: true,
    });
    expect(readMarkdown(editor)).toBe('```\nword\n```');
  });
});
