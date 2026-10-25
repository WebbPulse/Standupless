/**
 * Collapsible sections in a live editor: `>>> ` at the start of a line makes
 * one, the caret moves predictably between summary and body, Backspace at the
 * start of the summary takes the section apart again, and opening or closing
 * one is a view change that neither saves nor lands on the undo stack. Tab
 * and Shift+Tab in a summary nest and lift sections, one undo step each.
 */

import { Editor, type JSONContent } from '@tiptap/core';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUMMARY_PLACEHOLDER } from './CollapsibleSection';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source, with an update spy. */
const mounted = (
  source = ''
): { editor: Editor; onUpdate: ReturnType<typeof vi.fn> } => {
  const element = document.createElement('div');
  document.body.append(element);
  const onUpdate = vi.fn();
  const editor = new Editor({
    element,
    extensions: markdownExtensions(),
    onUpdate,
  });
  editors.push(editor);
  writeMarkdown(editor, source);
  return { editor, onUpdate };
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

/**
 * Presses a key through the editor's key handlers, as the keyboard does, and
 * answers whether a handler took it.
 */
const press = (editor: Editor, key: string, shiftKey = false): boolean => {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  return (
    editor.view.someProp('handleKeyDown', (handle) =>
      handle(editor.view, event)
    ) === true
  );
};

/** The name of the node the caret sits in. */
const caretIn = (editor: Editor): string =>
  editor.state.selection.$from.parent.type.name;

/**
 * The type names of the document's top level blocks, leaving out the empty
 * paragraph the editor keeps at the end so there is always a line to type on.
 */
const topLevel = (editor: Editor): (string | undefined)[] => {
  const blocks = editor.getJSON().content ?? [];
  const last = blocks.at(-1);
  const trailing =
    blocks.length > 1 &&
    last?.type === 'paragraph' &&
    (last.content ?? []).length === 0;
  return (trailing ? blocks.slice(0, -1) : blocks).map((child) => child.type);
};

/** The first section's attributes. */
const firstSectionOpen = (editor: Editor): unknown =>
  editor.getJSON().content?.[0]?.attrs?.['open'];

const STORED = '<details>\n<summary>Logs</summary>\n\nbody\n\n</details>';

describe('making a collapsible section', () => {
  it('turns >>> and a space on an empty line into an open section', () => {
    const { editor } = mounted();
    editor.commands.focus();
    typeText(editor, '>>> ');
    expect(topLevel(editor)).toEqual(['collapsibleSection']);
    expect(firstSectionOpen(editor)).toBe(true);
    expect(caretIn(editor)).toBe('collapsibleSummary');
    typeText(editor, 'Plan');
    expect(readMarkdown(editor)).toBe(
      '<details>\n<summary>Plan</summary>\n\n</details>'
    );
  });

  it('leaves >>> typed after other text alone', () => {
    const { editor } = mounted();
    editor.commands.focus();
    typeText(editor, 'a>>> ');
    expect(topLevel(editor)).toEqual(['paragraph']);
    expect(readMarkdown(editor)).toBe('a>>>');
  });

  it('leaves >>> inside code alone', () => {
    const { editor } = mounted('```\n\n```');
    editor.commands.setTextSelection(1);
    typeText(editor, '>>> ');
    expect(topLevel(editor)).toEqual(['codeBlock']);
  });

  it('wraps the current line, using its text as the summary', () => {
    const { editor } = mounted('first\n\nLogs');
    editor.commands.setTextSelection(9);
    expect(editor.commands.setCollapsibleSection()).toBe(true);
    expect(topLevel(editor)).toEqual(['paragraph', 'collapsibleSection']);
    expect(readMarkdown(editor)).toBe(
      'first\n\n<details>\n<summary>Logs</summary>\n\n</details>'
    );
  });

  it('shows a placeholder in an empty summary', () => {
    const { editor } = mounted();
    editor.commands.focus();
    typeText(editor, '>>> ');
    const summary = editor.view.dom.querySelector('.rich-collapsible-summary');
    expect(summary).toHaveClass('is-empty');
    expect(summary).toHaveAttribute('data-placeholder', SUMMARY_PLACEHOLDER);
    typeText(editor, 'x');
    expect(
      editor.view.dom.querySelector('.rich-collapsible-summary')
    ).not.toHaveClass('is-empty');
  });
});

describe('opening and closing a section', () => {
  it('reads a stored section closed and opens it from its toggle', () => {
    const { editor, onUpdate } = mounted(STORED);
    expect(firstSectionOpen(editor)).toBe(false);
    const toggle = editor.view.dom.querySelector('.rich-collapsible-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle as HTMLElement);
    expect(firstSectionOpen(editor)).toBe(true);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(editor.view.dom.querySelector('.rich-collapsible')).toHaveAttribute(
      'data-open',
      'true'
    );
    expect(readMarkdown(editor)).toBe(STORED);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(editor.can().undo()).toBe(false);
  });

  it('moves the caret out of a body as it closes', () => {
    const { editor } = mounted(STORED);
    editor.commands.toggleCollapsibleSection(0);
    editor.commands.setTextSelection(10);
    expect(caretIn(editor)).toBe('paragraph');
    editor.commands.toggleCollapsibleSection(0);
    expect(firstSectionOpen(editor)).toBe(false);
    expect(caretIn(editor)).toBe('collapsibleSummary');
    expect(editor.state.selection.from).toBe(6);
  });

  it('steps the caret over a closed body', () => {
    const { editor } = mounted(`${STORED}\n\nafter`);
    editor.commands.setTextSelection(6);
    editor.commands.setTextSelection(9);
    expect(editor.state.selection.$from.parent.textContent).toBe('after');
    editor.commands.setTextSelection(9);
    expect(caretIn(editor)).toBe('collapsibleSummary');
    expect(editor.state.selection.from).toBe(6);
  });
});

describe('the keyboard in a section', () => {
  it('unwraps an empty section on Backspace at the start of its summary', () => {
    const { editor } = mounted();
    editor.commands.focus();
    typeText(editor, '>>> ');
    press(editor, 'Backspace');
    expect(topLevel(editor)).toEqual(['paragraph']);
    expect(readMarkdown(editor)).toBe('');
  });

  it('keeps the summary and body as plain blocks when it unwraps', () => {
    const { editor } = mounted(STORED);
    editor.commands.toggleCollapsibleSection(0);
    editor.commands.setTextSelection(2);
    press(editor, 'Backspace');
    expect(readMarkdown(editor)).toBe('Logs\n\nbody');
    expect(caretIn(editor)).toBe('paragraph');
  });

  it('moves from the summary into the body on Enter, then out on a blank line', () => {
    const { editor } = mounted();
    editor.commands.focus();
    typeText(editor, '>>> Plan');
    press(editor, 'Enter');
    expect(caretIn(editor)).toBe('paragraph');
    expect(editor.state.selection.$from.node(-1).type.name).toBe(
      'collapsibleBody'
    );
    typeText(editor, 'step');
    press(editor, 'Enter');
    press(editor, 'Enter');
    expect(editor.state.selection.$from.depth).toBe(1);
    typeText(editor, 'after');
    expect(readMarkdown(editor)).toBe(
      '<details>\n<summary>Plan</summary>\n\nstep\n\n</details>\n\nafter'
    );
  });

  it('steps past a closed section on Enter in its summary', () => {
    const { editor } = mounted(STORED);
    editor.commands.setTextSelection(6);
    press(editor, 'Enter');
    expect(editor.state.selection.$from.depth).toBe(1);
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor.getJSON().content).toHaveLength(2);
  });

  it('returns from the start of the body to the summary on Backspace', () => {
    const { editor } = mounted(STORED);
    editor.commands.toggleCollapsibleSection(0);
    editor.commands.setTextSelection(9);
    press(editor, 'Backspace');
    expect(caretIn(editor)).toBe('collapsibleSummary');
    expect(readMarkdown(editor)).toBe(STORED);
  });
});

const NESTED =
  '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ntext\n\n</details>\n\n</details>';

const SIBLINGS =
  '<details>\n<summary>A</summary>\n\none\n\n</details>\n\n<details>\n<summary>B</summary>\n\ntwo\n\n</details>';

/** The number of items in the first list inside the first section's body. */
const bodyListItems = (editor: Editor): JSONContent[] => {
  const body = editor.getJSON().content?.[0]?.content?.[1];
  return body?.content?.[0]?.content ?? [];
};

describe('nesting sections with Tab and Shift+Tab', () => {
  it('reads and writes nested sections unchanged', () => {
    const { editor } = mounted(NESTED);
    expect(readMarkdown(editor)).toBe(NESTED);
  });

  it('lifts a nested section after its parent on Shift+Tab, and undoes in one step', () => {
    const { editor } = mounted(NESTED);
    editor.commands.toggleCollapsibleSection(0);
    editor.commands.setTextSelection(13);
    expect(caretIn(editor)).toBe('collapsibleSummary');
    expect(press(editor, 'Tab', true)).toBe(true);
    expect(readMarkdown(editor)).toBe(
      '<details>\n<summary>Outer</summary>\n\n</details>\n\n<details>\n<summary>Inner</summary>\n\ntext\n\n</details>'
    );
    expect(topLevel(editor)).toEqual([
      'collapsibleSection',
      'collapsibleSection',
    ]);
    expect(caretIn(editor)).toBe('collapsibleSummary');
    expect(editor.state.selection.$from.parent.textContent).toBe('Inner');
    expect(editor.state.selection.$from.depth).toBe(2);
    editor.commands.undo();
    expect(readMarkdown(editor)).toBe(NESTED);
  });

  it('keeps a top level section in place on Shift+Tab and holds the key', () => {
    const { editor } = mounted(STORED);
    editor.commands.setTextSelection(6);
    expect(press(editor, 'Tab', true)).toBe(true);
    expect(readMarkdown(editor)).toBe(STORED);
    expect(caretIn(editor)).toBe('collapsibleSummary');
  });

  it('nests a section into the end of the one above on Tab, and undoes in one step', () => {
    const { editor } = mounted(SIBLINGS);
    editor.commands.setTextSelection(15);
    expect(caretIn(editor)).toBe('collapsibleSummary');
    expect(press(editor, 'Tab')).toBe(true);
    expect(readMarkdown(editor)).toBe(
      '<details>\n<summary>A</summary>\n\none\n\n<details>\n<summary>B</summary>\n\ntwo\n\n</details>\n\n</details>'
    );
    expect(topLevel(editor)).toEqual(['collapsibleSection']);
    expect(firstSectionOpen(editor)).toBe(true);
    expect(caretIn(editor)).toBe('collapsibleSummary');
    expect(editor.state.selection.$from.parent.textContent).toBe('B');
    editor.commands.undo();
    expect(readMarkdown(editor)).toBe(SIBLINGS);
    expect(firstSectionOpen(editor)).toBe(false);
  });

  it('round trips a section nested with Tab and lifted with Shift+Tab', () => {
    const { editor } = mounted(SIBLINGS);
    editor.commands.setTextSelection(15);
    press(editor, 'Tab');
    press(editor, 'Tab', true);
    expect(readMarkdown(editor)).toBe(
      '<details>\n<summary>A</summary>\n\none\n\n</details>\n\n<details>\n<summary>B</summary>\n\ntwo\n\n</details>'
    );
  });

  it('holds Tab without a section above to nest into', () => {
    const { editor } = mounted(`first\n\n${STORED}`);
    editor.commands.setTextSelection(13);
    expect(caretIn(editor)).toBe('collapsibleSummary');
    expect(press(editor, 'Tab')).toBe(true);
    expect(readMarkdown(editor)).toBe(`first\n\n${STORED}`);
  });

  it('leaves Tab and Shift+Tab to a list inside a body', () => {
    const { editor } = mounted(
      '<details>\n<summary>L</summary>\n\n- one\n- two\n\n</details>'
    );
    editor.commands.toggleCollapsibleSection(0);
    editor.commands.setTextSelection(16);
    expect(editor.state.selection.$from.parent.textContent).toBe('two');
    press(editor, 'Tab');
    expect(bodyListItems(editor)).toHaveLength(1);
    expect(topLevel(editor)).toEqual(['collapsibleSection']);
    press(editor, 'Tab', true);
    expect(bodyListItems(editor)).toHaveLength(2);
    expect(topLevel(editor)).toEqual(['collapsibleSection']);
  });
});
