/**
 * Holds the editor's code block to how it should behave while typing: Tab and
 * Shift+Tab indent and outdent inside it, three Enters or the down arrow on
 * its last line leave it, the language picker writes the fence language, the
 * copy button copies the block, and highlighting arrives once the language
 * set has loaded.
 */

import {
  Editor,
  getExtensionField,
  type KeyboardShortcutCommand,
} from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';

const editors: Editor[] = [];
const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source. */
const editorWith = (source: string): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  writeMarkdown(editor, source);
  return editor;
};

/** Puts the cursor at an offset inside the first code block's text. */
const cursorAt = (editor: Editor, offset: number): void => {
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, 1 + offset)
    )
  );
};

/** Puts the cursor at the end of the first code block's text. */
const cursorAtEnd = (editor: Editor): void => {
  const block = editor.state.doc.firstChild;
  cursorAt(editor, block?.textContent.length ?? 0);
};

/** Presses a key on the document, as the keyboard would. */
const press = (editor: Editor, init: KeyboardEventInit): void => {
  act(() => {
    fireEvent.keyDown(editor.view.dom, init);
  });
};

/**
 * Runs the code block's own binding for a key, apart from the browser's
 * fallback, which jsdom's empty layout would otherwise answer.
 */
const codeBlockShortcut = (editor: Editor, key: string): boolean => {
  const extension = editor.extensionManager.extensions.find(
    (item) => item.name === 'codeBlock'
  );
  if (extension === undefined) throw new Error('no code block extension');
  const add = getExtensionField<() => Record<string, KeyboardShortcutCommand>>(
    extension,
    'addKeyboardShortcuts',
    {
      name: extension.name,
      options: extension.options as Record<string, unknown>,
      editor,
      type: editor.schema.nodes['codeBlock'],
    }
  );
  const binding = add()[key];
  if (binding === undefined) throw new Error(`no binding for ${key}`);
  let handled = false;
  act(() => {
    handled = binding({ editor });
  });
  return handled;
};

describe('code block keys', () => {
  it('indents on Tab and outdents on Shift+Tab', () => {
    const editor = editorWith('```ts\nconst a = 1;\n```');
    cursorAt(editor, 0);

    press(editor, { key: 'Tab', code: 'Tab' });
    expect(readMarkdown(editor)).toBe('```ts\n  const a = 1;\n```');

    press(editor, { key: 'Tab', code: 'Tab', shiftKey: true });
    expect(readMarkdown(editor)).toBe('```ts\nconst a = 1;\n```');
  });

  it('leaves the block after three Enters at its end', () => {
    const editor = editorWith('```ts\ncode\n```');
    cursorAtEnd(editor);

    press(editor, { key: 'Enter', code: 'Enter' });
    press(editor, { key: 'Enter', code: 'Enter' });
    press(editor, { key: 'Enter', code: 'Enter' });

    const { doc, selection } = editor.state;
    expect(doc.firstChild?.type.name).toBe('codeBlock');
    expect(doc.firstChild?.textContent).toBe('code');
    expect(doc.lastChild?.type.name).toBe('paragraph');
    expect(selection.$from.parent.type.name).toBe('paragraph');
  });

  it('leaves the last block on the down arrow from its last line', () => {
    const editor = editorWith('```ts\nfirst\nlast\n```');
    cursorAt(editor, 'first\nla'.length);

    press(editor, { key: 'ArrowDown', code: 'ArrowDown' });

    const { doc, selection } = editor.state;
    expect(doc.childCount).toBe(2);
    expect(doc.lastChild?.type.name).toBe('paragraph');
    expect(selection.$from.parent.type.name).toBe('paragraph');
  });

  it('moves into the next block on the down arrow from its last line', () => {
    const editor = editorWith('```ts\nonly\n```\n\nafter');
    cursorAt(editor, 1);

    press(editor, { key: 'ArrowDown', code: 'ArrowDown' });

    const { doc, selection } = editor.state;
    expect(doc.childCount).toBe(2);
    expect(selection.$from.parent.textContent).toBe('after');
  });

  it('leaves the down arrow above the last line to the editor', () => {
    const editor = editorWith('```ts\nfirst\nlast\n```');
    cursorAt(editor, 1);

    expect(codeBlockShortcut(editor, 'ArrowDown')).toBe(false);
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock');
  });
});

describe('code block bar', () => {
  /** The language picker on the first code block. */
  const picker = (): HTMLSelectElement => {
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Code language"]'
    );
    if (select === null) throw new Error('no language picker');
    return select;
  };

  it('shows an alias as its language and keeps the alias in the fence', () => {
    const editor = editorWith('```ts\nconst a = 1;\n```');

    expect(picker().value).toBe('typescript');
    expect(readMarkdown(editor)).toBe('```ts\nconst a = 1;\n```');
  });

  it('writes the picked language into the fence', () => {
    const editor = editorWith('```ts\nprint(1)\n```');

    act(() => {
      fireEvent.change(picker(), { target: { value: 'python' } });
    });
    expect(readMarkdown(editor)).toBe('```python\nprint(1)\n```');

    act(() => {
      fireEvent.change(picker(), { target: { value: '' } });
    });
    expect(readMarkdown(editor)).toBe('```\nprint(1)\n```');
  });

  it('offers a language it does not list rather than dropping it', () => {
    editorWith('```foo\nx\n```');

    expect(picker().value).toBe('foo');
  });

  it('copies the block and confirms it', async () => {
    editorWith('```ts\nconst a = 1;\nconst b = 2;\n```');
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code"]'
    );
    if (button === null) throw new Error('no copy button');

    act(() => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      expect(button).toHaveAttribute('aria-label', 'Copied');
    });
    expect(writeText).toHaveBeenCalledWith('const a = 1;\nconst b = 2;');
  });

  it('highlights the code once the language set has loaded', async () => {
    editorWith('```ts\nconst a = 1;\n```');

    await waitFor(() => {
      expect(
        document.querySelector('.code-highlight .hljs-keyword')
      ).not.toBeNull();
    });
  });
});
