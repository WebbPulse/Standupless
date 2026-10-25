/**
 * Filing an issue from selected text. Covers how a selection splits into the
 * title and the description Markdown, that the toolbar offers the button only
 * when the surface can file one, that filing replaces the selection with the
 * new key while cancelling leaves the text alone, and that a range changed in
 * the meantime is never overwritten.
 */

import { Editor } from '@tiptap/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateIssueOptions } from '../../hooks/useCreateIssue';
import { TITLE_MAX } from '../../lib/validation';
import type { IssueRead } from '../../types/Api';
import { FormattingButtons } from './FormattingToolbar';
import { CREATE_ISSUE_LABEL } from './formatting';
import { markdownExtensions } from './markdownExtensions';
import { readMarkdown, writeMarkdown } from './markdownCodec';
import {
  createIssueFromSelection,
  replaceWithIssueKey,
  selectionPrefill,
  titleOfLine,
} from './selectionIssue';

const editors: Editor[] = [];

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

/** A mounted editor holding a Markdown source, with ENG keys as references. */
const editorWith = (source: string): Editor => {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: markdownExtensions({
      isIssueKey: (key) => key.startsWith('ENG-'),
    }),
  });
  editors.push(editor);
  writeMarkdown(editor, source);
  return editor;
};

/** Selects all of the document's text. */
const selectAll = (editor: Editor): void => {
  editor.commands.setTextSelection({
    from: 1,
    to: editor.state.doc.content.size - 1,
  });
};

/** Selects the first occurrence of some text in the document. */
const selectText = (editor: Editor, text: string): void => {
  const found: { from: number; to: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (found.length > 0) return false;
    const at = node.isText ? (node.text ?? '').indexOf(text) : -1;
    if (at >= 0) found.push({ from: pos + at, to: pos + at + text.length });
    return true;
  });
  const [range] = found;
  if (range === undefined) throw new Error(`no ${text}`);
  editor.commands.setTextSelection(range);
};

/** The prefill the editor's current selection gives. */
const prefillOf = (editor: Editor) => {
  const { from, to } = editor.state.selection;
  return selectionPrefill(editor, from, to);
};

/** A filed issue with just the key the replacement reads. */
const filed = (key: string): IssueRead => ({ key }) as IssueRead;

describe('the selection prefill', () => {
  it('takes a single line as the title with no description', () => {
    const editor = editorWith('Fix the login redirect');
    selectAll(editor);

    expect(prefillOf(editor)).toEqual({
      title: 'Fix the login redirect',
      description: '',
    });
  });

  it('splits the first block from the rest, kept as Markdown', () => {
    const editor = editorWith(
      'Fix the login redirect\n\nIt loops on **Safari**.\n\n- one\n- two'
    );
    selectAll(editor);

    expect(prefillOf(editor)).toEqual({
      title: 'Fix the login redirect',
      description: 'It loops on **Safari**.\n\n- one\n- two',
    });
  });

  it('ends the title at a hard break', () => {
    const editor = editorWith('First line  \nsecond line');
    selectAll(editor);

    expect(prefillOf(editor)).toEqual({
      title: 'First line',
      description: 'second line',
    });
  });

  it('takes only the selected part of a line', () => {
    const editor = editorWith('Before the words we want, and after');
    selectText(editor, 'the words we want');

    expect(prefillOf(editor)).toEqual({
      title: 'the words we want',
      description: '',
    });
  });

  it('strips formatting from the title and skips an empty first line', () => {
    const editor = editorWith('Intro\n\n**Bold** title\n\nBody');
    const { doc } = editor.state;
    const first = doc.child(0);
    editor.commands.setTextSelection({
      from: first.nodeSize - 1,
      to: doc.content.size - 1,
    });

    expect(prefillOf(editor)).toEqual({
      title: 'Bold title',
      description: 'Body',
    });
  });

  it('collapses spaces and caps the title at the limit', () => {
    expect(titleOfLine('  a   b  ')).toBe('a b');
    expect(titleOfLine('x'.repeat(TITLE_MAX + 20))).toHaveLength(TITLE_MAX);
  });
});

describe('the create issue button', () => {
  it('shows only when the surface can file an issue', () => {
    const editor = editorWith('word');
    selectAll(editor);
    const { unmount } = render(
      <FormattingButtons editor={editor} context={{ openLink: vi.fn() }} />
    );
    expect(
      screen.queryByRole('button', { name: CREATE_ISSUE_LABEL })
    ).toBeNull();
    unmount();

    const createIssue = vi.fn();
    render(
      <FormattingButtons
        editor={editor}
        context={{ openLink: vi.fn(), createIssue }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: CREATE_ISSUE_LABEL }));

    expect(createIssue).toHaveBeenCalledTimes(1);
  });
});

describe('filing an issue from the selection', () => {
  /** Opens the dialog on the selection and hands back what it was asked. */
  const openOn = (
    editor: Editor,
    source: { teamId?: string; issueId?: string } = {}
  ): CreateIssueOptions => {
    const open = vi.fn<(options: CreateIssueOptions) => void>();
    expect(createIssueFromSelection(editor, source, open)).toBe(true);
    const options = open.mock.calls[0]?.[0];
    if (options === undefined) throw new Error('dialog did not open');
    return options;
  };

  it('opens the dialog on the team and issue the text came from', () => {
    const editor = editorWith('See the crash\n\nStack trace here');
    selectAll(editor);

    const options = openOn(editor, { teamId: 'team-1', issueId: 'issue-1' });

    expect(options).toMatchObject({
      teamId: 'team-1',
      relatedIssueId: 'issue-1',
      title: 'See the crash',
      description: 'Stack trace here',
    });
  });

  it('replaces the selection with the new issue key once filed', () => {
    const editor = editorWith('Before the crash after');
    selectText(editor, 'the crash');

    openOn(editor).onCreated?.(filed('ENG-42'));

    expect(readMarkdown(editor)).toBe('Before ENG-42 after');
    expect(
      Array.from(editor.view.dom.querySelectorAll('.rich-issue-ref')).map(
        (node) => node.textContent
      )
    ).toEqual(['ENG-42']);
  });

  it('leaves the text alone when the dialog is cancelled', () => {
    const editor = editorWith('Before the crash after');
    selectText(editor, 'the crash');

    openOn(editor);

    expect(readMarkdown(editor)).toBe('Before the crash after');
  });

  it('never overwrites a range whose text changed meanwhile', () => {
    const editor = editorWith('Before the crash after');
    selectText(editor, 'the crash');
    const { from, to } = editor.state.selection;
    editor.commands.insertContentAt(from, 'not ');

    expect(
      replaceWithIssueKey(editor, { from, to, text: 'the crash' }, 'ENG-1')
    ).toBe(false);
    expect(readMarkdown(editor)).toBe('Before not the crash after');
  });

  it('does not open on a selection with no text', () => {
    const editor = editorWith('word');
    editor.commands.setTextSelection(1);
    const open = vi.fn();

    expect(createIssueFromSelection(editor, {}, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
