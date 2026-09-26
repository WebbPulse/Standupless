/**
 * Posting a comment from the keyboard. Ctrl+Enter and Cmd+Enter post exactly
 * the text written, insert nothing into the box on the way, and leave the box
 * empty, including when the browser follows the key with a stray character
 * such as the carriage return a synthetic Enter can carry.
 */

import type { Editor } from '@tiptap/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRead } from '../../types/Api';
import CommentComposer from './CommentComposer';

const createComment = vi.fn<(body: unknown) => Promise<CommentRead>>();

vi.mock('../../api/discussion', () => ({
  createComment: (_w: string, _i: string, body: unknown) => createComment(body),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

/** The composer surface once the lazy editor has arrived. */
const findSurface = async (): Promise<HTMLElement> =>
  screen.findByRole(
    'textbox',
    { name: 'Write a comment' },
    { timeout: 10_000 }
  );

/** The Tiptap editor behind a surface. */
const editorOf = (surface: HTMLElement): Editor =>
  (surface as HTMLElement & { editor: Editor }).editor;

/** Feeds text through the editor's own text input path, as typing does. */
const typeText = (editor: Editor, text: string): boolean => {
  const { from, to } = editor.state.selection;
  const handled = editor.view.someProp('handleTextInput', (handle) =>
    handle(editor.view, from, to, text, () => editor.state.tr.insertText(text))
  );
  if (handled !== true) {
    editor.view.dispatch(editor.state.tr.insertText(text, from, to));
  }
  return handled === true;
};

beforeEach(() => {
  createComment.mockReset();
  createComment.mockImplementation(() => Promise.resolve({} as CommentRead));
});

describe.each([
  { name: 'Ctrl+Enter', init: { ctrlKey: true } },
  { name: 'Cmd+Enter', init: { metaKey: true } },
])('posting with $name', ({ init }) => {
  it('posts the exact body and inserts nothing', async () => {
    const onPosted = vi.fn();
    render(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        onPosted={onPosted}
      />
    );
    const surface = await findSurface();
    const editor = editorOf(surface);

    act(() => {
      typeText(editor, 'Ship it once CI is green');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Comment' })).toBeEnabled();
    });

    act(() => {
      const down = fireEvent.keyDown(surface, { key: 'Enter', ...init });
      expect(down).toBe(false);
      fireEvent.keyPress(surface, {
        key: 'Enter',
        code: 'Enter',
        charCode: 13,
        ...init,
      });
    });

    await waitFor(() => {
      expect(onPosted).toHaveBeenCalledTimes(1);
    });
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledWith({
      body: 'Ship it once CI is green',
    });
    expect(editor.getMarkdown()).toBe('');
    expect(editor.getText()).toBe('');
  });

  it('drops a control character that trails the key press', async () => {
    let settle: (value: CommentRead) => void = () => undefined;
    createComment.mockImplementation(
      () =>
        new Promise<CommentRead>((resolve) => {
          settle = resolve;
        })
    );
    render(<CommentComposer workspaceId="ws-1" issueId="iss-1" people={[]} />);
    const surface = await findSurface();
    const editor = editorOf(surface);

    act(() => {
      typeText(editor, 'Looks right');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Comment' })).toBeEnabled();
    });
    act(() => {
      fireEvent.keyDown(surface, { key: 'Enter', ...init });
      typeText(editor, '\r');
    });

    expect(createComment).toHaveBeenCalledWith({ body: 'Looks right' });
    expect(editor.getText()).toBe('Looks right');
    await act(async () => {
      settle({} as CommentRead);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(editor.getText()).toBe('');
    });
  });
});
