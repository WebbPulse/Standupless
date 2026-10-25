/**
 * Holds the list chords to Linear's keys: Mod-Shift-7 a checklist, 8 a
 * bulleted list and 9 a numbered list, each chord doing one thing. Mod-Enter
 * checks the checklist item at the caret, with Shift its nested items too, and
 * outside a checklist item still submits the surface.
 */

import { Editor } from '@tiptap/core';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORMAT_ACTIONS, actionTooltip } from './formatting';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import { RichMarkdownEditor } from './RichMarkdownEditor';
import { SLASH_COMMANDS } from './slashCommands';

const editors: Editor[] = [];

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source, with the caret at `at`. */
const editorWith = (source: string, at = 1): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, source);
  editor.commands.setTextSelection(at);
  return editor;
};

/** The caret position just inside the first text matching `text`. */
const positionOf = (editor: Editor, text: string): number => {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found === -1 && node.isText && node.text?.includes(text) === true) {
      found = position + 1;
    }
  });
  return found;
};

/** Presses a chord on an element, as the keyboard would. */
const press = (
  target: HTMLElement,
  init: KeyboardEventInit & { keyCode?: number }
): void => {
  act(() => {
    fireEvent.keyDown(target, init);
  });
};

/** Ctrl+Shift and a digit, with the shifted key a US layout reports. */
const shiftDigit = (digit: '7' | '8' | '9'): KeyboardEventInit => ({
  key: { '7': '&', '8': '*', '9': '(' }[digit],
  code: `Digit${digit}`,
  keyCode: 48 + Number(digit),
  ctrlKey: true,
  shiftKey: true,
});

/** Each checklist item's checked state, in document order. */
const checkedStates = (editor: Editor): boolean[] => {
  const states: boolean[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'taskItem') states.push(node.attrs['checked'] === true);
  });
  return states;
};

const ENTER = { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true };

describe('list chords', () => {
  it.each([
    ['7', '- [ ] word'],
    ['8', '- word'],
    ['9', '1. word'],
  ] as const)('Ctrl+Shift+%s makes one kind of list', (digit, written) => {
    const editor = editorWith('word');
    press(editor.view.dom, shiftDigit(digit));
    expect(readMarkdown(editor)).toBe(written);
    press(editor.view.dom, shiftDigit(digit));
    expect(readMarkdown(editor)).toBe('word');
  });

  it('names the new chords in the toolbar and the slash menu', () => {
    const tooltip = (id: string): string | undefined => {
      const action = FORMAT_ACTIONS.find((each) => each.id === id);
      return action === undefined ? undefined : actionTooltip(action, false);
    };
    expect(tooltip('taskList')).toBe('Checklist  Ctrl+Shift+7');
    expect(tooltip('bulletList')).toBe('Bulleted list  Ctrl+Shift+8');
    expect(tooltip('orderedList')).toBe('Numbered list  Ctrl+Shift+9');
    const keys = (id: string): string[] | undefined =>
      SLASH_COMMANDS.find((command) => command.id === id)?.keys;
    expect(keys('taskList')).toEqual(['mod', 'shift', '7']);
    expect(keys('bulletList')).toEqual(['mod', 'shift', '8']);
    expect(keys('orderedList')).toEqual(['mod', 'shift', '9']);
  });
});

describe('checking a checklist item', () => {
  const NESTED = '- [ ] parent\n  - [ ] child';

  it('checks and unchecks the item at the caret on Ctrl+Enter', () => {
    const editor = editorWith('- [ ] task');
    editor.commands.setTextSelection(positionOf(editor, 'task'));
    press(editor.view.dom, ENTER);
    expect(readMarkdown(editor)).toBe('- [x] task');
    press(editor.view.dom, ENTER);
    expect(readMarkdown(editor)).toBe('- [ ] task');
  });

  it('leaves nested items alone without Shift', () => {
    const editor = editorWith(NESTED);
    editor.commands.setTextSelection(positionOf(editor, 'parent'));
    press(editor.view.dom, ENTER);
    expect(checkedStates(editor)).toEqual([true, false]);
  });

  it('checks nested items to the same state with Shift', () => {
    const editor = editorWith('- [ ] parent\n  - [x] child');
    editor.commands.setTextSelection(positionOf(editor, 'parent'));
    expect(checkedStates(editor)).toEqual([false, true]);
    press(editor.view.dom, { ...ENTER, shiftKey: true });
    expect(checkedStates(editor)).toEqual([true, true]);
    press(editor.view.dom, { ...ENTER, shiftKey: true });
    expect(checkedStates(editor)).toEqual([false, false]);
  });
});

describe('Ctrl+Enter in a surface', () => {
  /** Renders a composer surface holding `value` with a submit spy. */
  const renderComposer = (
    value: string
  ): { surface: HTMLElement; editor: Editor; onSubmit: () => void } => {
    const onSubmit = vi.fn();
    render(
      <RichMarkdownEditor
        value={value}
        editable
        ariaLabel="Comment"
        onCommit={() => true}
        onSubmit={onSubmit}
      />
    );
    const surface = screen.getByRole('textbox', { name: 'Comment' });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => {
      editor.commands.focus();
    });
    return { surface, editor, onSubmit };
  };

  it('checks a checklist item instead of submitting', () => {
    const { surface, editor, onSubmit } = renderComposer('- [ ] task');
    act(() => {
      editor.commands.setTextSelection(positionOf(editor, 'task'));
    });
    press(surface, ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(readMarkdown(editor)).toBe('- [x] task');
  });

  it('submits outside a checklist item', () => {
    const { surface, editor, onSubmit } = renderComposer('a comment');
    act(() => {
      editor.commands.setTextSelection(positionOf(editor, 'comment'));
    });
    press(surface, ENTER);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(readMarkdown(editor)).toBe('a comment');
  });
});
