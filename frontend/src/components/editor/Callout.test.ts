/**
 * Callouts in a live editor: the commands wrap and re-kind one, the switcher
 * on the node changes its kind, Backspace at its start and Enter on an empty
 * last line leave it as they would a list, and a GitHub alert pasted as HTML
 * arrives as a callout of the same kind.
 */

import { Editor } from '@tiptap/core';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source. */
const mounted = (source = ''): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, source);
  return editor;
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

/** The type names of the document's top level blocks. */
const topLevel = (editor: Editor): (string | undefined)[] =>
  (editor.getJSON().content ?? []).map((child) => child.type);

describe('making a callout', () => {
  it('wraps the current line in a note by default', () => {
    const editor = mounted('Plan');
    editor.commands.setTextSelection(3);
    expect(editor.commands.setCallout()).toBe(true);
    expect(readMarkdown(editor)).toBe('> [!NOTE]\n> Plan');
  });

  it('changes the kind of the callout the caret is already in', () => {
    const editor = mounted('> [!NOTE]\n> Plan');
    editor.commands.setTextSelection(3);
    editor.commands.setCallout('warning');
    expect(readMarkdown(editor)).toBe('> [!WARNING]\n> Plan');
    expect(topLevel(editor)[0]).toBe('callout');
    expect(editor.getJSON().content?.[0]?.content?.[0]?.type).toBe('paragraph');
  });

  it('reads a GitHub alert pasted as HTML as a callout of its kind', () => {
    const editor = mounted();
    editor.commands.setContent(
      '<div class="markdown-alert markdown-alert-caution"><p class="markdown-alert-title">Caution</p><p>Hot</p></div>'
    );
    expect(readMarkdown(editor)).toBe('> [!CAUTION]\n> Hot');
  });
});

describe('the kind switcher', () => {
  it('lists every kind and marks the current one', () => {
    const editor = mounted('> [!TIP]\n> Plan');
    const options = editor.view.dom.querySelectorAll(
      '.callout-switcher-option'
    );
    expect(options[0]?.querySelector('svg')).not.toBeNull();
    expect(
      Array.from(options).map((option) => option.getAttribute('aria-label'))
    ).toEqual(['Note', 'Tip', 'Important', 'Warning', 'Danger']);
    const pressed = editor.view.dom.querySelector(
      '.callout-switcher-option[aria-pressed="true"]'
    );
    expect(pressed).toHaveAttribute('data-kind', 'tip');
    expect(editor.view.dom.querySelector('.callout')).toHaveAttribute(
      'data-kind',
      'tip'
    );
  });

  it('changes the stored kind when an option is clicked', () => {
    const editor = mounted('> [!NOTE]\n> Plan');
    const danger = editor.view.dom.querySelector(
      '.callout-switcher-option[data-kind="danger"]'
    );
    expect(danger).not.toBeNull();
    if (danger === null) return;
    fireEvent.click(danger);
    expect(readMarkdown(editor)).toBe('> [!CAUTION]\n> Plan');
    expect(editor.view.dom.querySelector('.callout')).toHaveAttribute(
      'data-kind',
      'danger'
    );
  });

  it('is hidden in a read-only editor', () => {
    const editor = mounted('> [!NOTE]\n> Plan');
    editor.setEditable(false);
    writeMarkdown(editor, '> [!TIP]\n> Plan');
    const switcher = editor.view.dom.querySelector('.callout-switcher');
    expect(switcher).toHaveAttribute('hidden');
  });
});

describe('leaving a callout', () => {
  it('unwraps an empty callout on Backspace at its start', () => {
    const editor = mounted('> [!NOTE]');
    editor.commands.setTextSelection(2);
    press(editor, 'Backspace');
    expect(topLevel(editor)).not.toContain('callout');
    expect(readMarkdown(editor)).toBe('');
  });

  it('keeps the text when Backspace unwraps a filled callout', () => {
    const editor = mounted('> [!TIP]\n> one\n>\n> two');
    editor.commands.setTextSelection(2);
    press(editor, 'Backspace');
    expect(readMarkdown(editor)).toBe('one\n\ntwo');
    expect(editor.state.selection.$from.parent.textContent).toBe('one');
  });

  it('leaves Backspace inside the text to the editor', () => {
    const editor = mounted('> [!NOTE]\n> Plan');
    editor.commands.setTextSelection(4);
    press(editor, 'Backspace');
    expect(topLevel(editor)[0]).toBe('callout');
  });

  it('steps out on Enter at an empty last line', () => {
    const editor = mounted('> [!NOTE]\n> Plan');
    editor.commands.setTextSelection(6);
    editor.commands.splitBlock();
    expect(editor.state.selection.$from.node(-1).type.name).toBe('callout');
    press(editor, 'Enter');
    expect(editor.state.selection.$from.depth).toBe(1);
    editor.commands.insertContent('after');
    expect(readMarkdown(editor)).toBe('> [!NOTE]\n> Plan\n\nafter');
  });

  it('removes the callout with the unset command', () => {
    const editor = mounted('> [!WARNING]\n> Plan');
    editor.commands.setTextSelection(4);
    expect(editor.commands.unsetCallout()).toBe(true);
    expect(readMarkdown(editor)).toBe('Plan');
  });
});
