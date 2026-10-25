/**
 * Holds the editor's diagram block to how it should behave: a `mermaid` code
 * block shows its diagram while the caret is elsewhere, opens its source when
 * the caret moves in and closes it again when the caret leaves, the toggle
 * picks a face that stays, picking Mermaid in the language picker turns the
 * diagram on, and none of it changes the Markdown the block stores.
 */

import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MermaidResult } from '../../lib/mermaid';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';

const renderMermaid = vi.hoisted(() =>
  vi.fn((_source: string, _dark: boolean): Promise<MermaidResult> =>
    Promise.resolve({ ok: true, svg: '<svg data-drawn="yes"></svg>' })
  )
);

vi.mock('../../lib/mermaid', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  renderMermaid,
}));

const SOURCE = 'Intro\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nOutro';

const editors: Editor[] = [];

beforeEach(() => {
  renderMermaid.mockClear();
});

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source, with the caret in its first line. */
const editorWith = (source: string): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({ element, extensions: markdownExtensions() });
  editors.push(editor);
  act(() => {
    writeMarkdown(editor, source);
    editor.commands.setTextSelection(1);
  });
  return editor;
};

/** The first code block's outer element. */
const block = (editor: Editor): HTMLElement => {
  const found = editor.view.dom.querySelector<HTMLElement>('.rich-code-block');
  if (found === null) throw new Error('no code block');
  return found;
};

/** The position just inside the first code block's text. */
const codeStart = (editor: Editor): number => {
  let start = -1;
  editor.state.doc.descendants((node, position) => {
    if (start === -1 && node.type.name === 'codeBlock') start = position + 1;
    return start === -1;
  });
  return start;
};

/** Moves the caret to a position. */
const caretAt = (editor: Editor, position: number): void => {
  act(() => {
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, position)
      )
    );
  });
};

/** One of the toggle's buttons. */
const toggleButton = (editor: Editor, face: 'code' | 'preview') => {
  const button = block(editor).querySelector<HTMLButtonElement>(
    `.mermaid-toggle button[data-face="${face}"]`
  );
  if (button === null) throw new Error(`no ${face} button`);
  return button;
};

describe('the editor diagram block', () => {
  it('shows the diagram while the caret is elsewhere', async () => {
    const editor = editorWith(SOURCE);

    expect(block(editor).dataset['mermaid']).toBe('preview');
    await waitFor(() => {
      expect(
        block(editor).querySelector('svg[data-drawn="yes"]')
      ).not.toBeNull();
    });
    expect(renderMermaid).toHaveBeenCalledWith(
      'graph TD\n  A --> B',
      expect.any(Boolean)
    );
    expect(toggleButton(editor, 'preview')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('opens the source while the caret is in it and closes it after', () => {
    const editor = editorWith(SOURCE);

    caretAt(editor, codeStart(editor) + 2);
    expect(block(editor).dataset['mermaid']).toBe('code');

    caretAt(editor, 1);
    expect(block(editor).dataset['mermaid']).toBe('preview');
  });

  it('keeps the face the toggle picked', () => {
    const editor = editorWith(SOURCE);

    act(() => {
      fireEvent.click(toggleButton(editor, 'code'));
    });
    expect(block(editor).dataset['mermaid']).toBe('code');
    caretAt(editor, codeStart(editor) + 2);
    caretAt(editor, 1);
    expect(block(editor).dataset['mermaid']).toBe('code');

    act(() => {
      fireEvent.click(toggleButton(editor, 'preview'));
    });
    expect(block(editor).dataset['mermaid']).toBe('preview');
  });

  it('opens the source when the diagram is clicked', async () => {
    const editor = editorWith(SOURCE);
    await waitFor(() => {
      expect(
        block(editor).querySelector('svg[data-drawn="yes"]')
      ).not.toBeNull();
    });

    const preview = block(editor).querySelector('.mermaid-preview');
    if (preview === null) throw new Error('no preview');
    act(() => {
      fireEvent.click(preview);
    });
    expect(block(editor).dataset['mermaid']).toBe('code');
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock');
  });

  it('turns the diagram on when Mermaid is picked as the language', () => {
    const editor = editorWith('Intro\n\n```\ngraph TD\n```');

    expect(block(editor).dataset['mermaid']).toBeUndefined();
    const toggle = block(editor).querySelector<HTMLElement>('.mermaid-toggle');
    expect(toggle?.hidden).toBe(true);

    const picker = block(editor).querySelector('select');
    if (picker === null) throw new Error('no picker');
    act(() => {
      fireEvent.change(picker, { target: { value: 'mermaid' } });
    });
    expect(block(editor).dataset['mermaid']).toBe('preview');
    expect(toggle?.hidden).toBe(false);
    expect(readMarkdown(editor)).toBe('Intro\n\n```mermaid\ngraph TD\n```');
  });

  it('stores the block as an ordinary fenced block', () => {
    const editor = editorWith(SOURCE);

    act(() => {
      fireEvent.click(toggleButton(editor, 'code'));
    });
    expect(readMarkdown(editor)).toBe(SOURCE);
  });
});
