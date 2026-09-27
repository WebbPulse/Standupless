/**
 * The comment composer. Covers that a pasted image lands in the comment as an
 * embed of its stored content path, and that posting links only the uploads
 * the text still embeds while deleting the rest.
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
import type { AttachmentRead, CommentRead } from '../../types/Api';
import CommentComposer from './CommentComposer';

const createComment = vi.fn<(body: unknown) => Promise<CommentRead>>();
const uploadAttachment = vi.fn<(file: File) => Promise<AttachmentRead>>();
const deleteAttachment = vi.fn<(id: string) => Promise<void>>();

vi.mock('../../api/discussion', () => ({
  createComment: (_w: string, _i: string, body: unknown) => createComment(body),
  uploadAttachment: (_w: string, _i: string, file: File) =>
    uploadAttachment(file),
  deleteAttachment: (_w: string, id: string) => deleteAttachment(id),
}));

/** One committed attachment with the id given. */
const attachment = (id: string, title: string): AttachmentRead => ({
  attachment_id: id,
  issue_id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  kind: 'file',
  title,
  uploaded_by: 'user-1',
  created_at: '2026-09-26T00:00:00Z',
});

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

/** Pastes files onto a surface as a screenshot paste would. */
const pasteFiles = (surface: HTMLElement, files: File[]): void => {
  fireEvent.paste(surface, {
    clipboardData: {
      files,
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      types: ['Files'],
      getData: () => '',
    },
  });
};

const PATH = '/api/workspaces/ws-1/attachments';

beforeEach(() => {
  createComment.mockReset();
  uploadAttachment.mockReset();
  deleteAttachment.mockReset();
  deleteAttachment.mockResolvedValue(undefined);
});

describe('the comment composer', () => {
  it('embeds a pasted image and posts it linked to the comment', async () => {
    uploadAttachment.mockResolvedValue(attachment('att-1', 'shot.png'));
    createComment.mockImplementation(() => Promise.resolve({} as CommentRead));
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

    pasteFiles(surface, [new File(['png'], 'shot.png', { type: 'image/png' })]);

    const src = `${PATH}/att-1/content?issue_id=iss-1`;
    await waitFor(() => {
      expect(editorOf(surface).getMarkdown()).toContain(`![shot.png](${src})`);
    });
    const send = screen.getByRole('button', { name: 'Comment' });
    await waitFor(() => {
      expect(send).toBeEnabled();
    });

    act(() => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(onPosted).toHaveBeenCalled();
    });
    expect(createComment).toHaveBeenCalledWith({
      body: `![shot.png](${src})`,
      attachment_ids: ['att-1'],
    });
    expect(deleteAttachment).not.toHaveBeenCalled();
  });

  it('deletes an upload the text no longer embeds when it posts', async () => {
    uploadAttachment.mockResolvedValue(attachment('att-2', 'gone.png'));
    createComment.mockImplementation(() => Promise.resolve({} as CommentRead));
    render(<CommentComposer workspaceId="ws-1" issueId="iss-1" people={[]} />);
    const surface = await findSurface();

    pasteFiles(surface, [new File(['png'], 'gone.png', { type: 'image/png' })]);
    await waitFor(() => {
      expect(editorOf(surface).getMarkdown()).toContain('att-2');
    });

    act(() => {
      editorOf(surface).commands.setContent('Never mind');
    });
    const send = screen.getByRole('button', { name: 'Comment' });
    await waitFor(() => {
      expect(send).toBeEnabled();
    });
    act(() => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(deleteAttachment).toHaveBeenCalledWith('att-2');
    });
    expect(createComment).toHaveBeenCalledWith({ body: 'Never mind' });
  });
});
