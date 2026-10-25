/**
 * The comment composer. Covers that a pasted image lands in the comment as an
 * embed of its stored content path, and that posting links only the uploads
 * the text still embeds while deleting the rest, and that a new thread can be
 * synced to a linked pull request as it posts, with a warning for a public one.
 * Also covers a quote request: it lands after what is written, each request
 * once, and a quote made before the editor arrived lands when it does.
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
import type {
  AttachmentRead,
  CommentRead,
  GithubThreadTargetRead,
} from '../../types/Api';
import { readMarkdown } from '../editor/markdownCodec';
import CommentComposer from './CommentComposer';

const createComment = vi.fn<(body: unknown) => Promise<CommentRead>>();
const uploadAttachment = vi.fn<(file: File) => Promise<AttachmentRead>>();
const deleteAttachment = vi.fn<(id: string) => Promise<void>>();
const syncThread =
  vi.fn<(commentId: string, payload: unknown) => Promise<unknown>>();

vi.mock('../../api/drafts', () => ({
  listIssueDrafts: () => Promise.resolve([]),
  saveDraft: () => Promise.resolve({}),
  deleteDraft: () => Promise.resolve(),
}));

vi.mock('../../api/discussion', () => ({
  createComment: (_w: string, _i: string, body: unknown) => createComment(body),
  uploadAttachment: (_w: string, _i: string, file: File) =>
    uploadAttachment(file),
  deleteAttachment: (_w: string, id: string) => deleteAttachment(id),
}));

vi.mock('../../api/integrations', () => ({
  syncThread: (_w: string, _i: string, commentId: string, payload: unknown) =>
    syncThread(commentId, payload),
}));

/** A linked pull request a new thread may sync to. */
const target = (
  overrides: Partial<GithubThreadTargetRead> = {}
): GithubThreadTargetRead => ({
  kind: 'pull_request',
  repository_id: 'repo-1',
  full_name: 'acme/api',
  number: 7,
  title: 'Fix the login',
  url: 'https://github.com/acme/api/pull/7',
  private: true,
  ref: 'acme/api#7',
  ...overrides,
});

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
  syncThread.mockReset();
  syncThread.mockResolvedValue({});
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

  it('syncs a new thread to the one linked pull request as it posts', async () => {
    createComment.mockResolvedValue({ comment_id: 'c-9' } as CommentRead);
    render(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        threadTargets={[target()]}
      />
    );
    const surface = await findSurface();
    act(() => {
      editorOf(surface).commands.setContent('Ready for review');
    });

    const toggle = screen.getByRole('button', { name: /Sync to GitHub/ });
    act(() => {
      fireEvent.click(toggle);
    });
    expect(
      screen.getByRole('button', { name: /Syncing to acme\/api#7/ })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('status')).toBeNull();

    const send = screen.getByRole('button', { name: 'Comment' });
    await waitFor(() => {
      expect(send).toBeEnabled();
    });
    act(() => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(syncThread).toHaveBeenCalledWith('c-9', {
        repository_id: 'repo-1',
        number: 7,
      });
    });
  });

  it('warns before syncing a thread to a public repository', async () => {
    render(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        threadTargets={[target({ private: false })]}
      />
    );
    await findSurface();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Sync to GitHub/ }));
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Public repository: anyone can read this thread on GitHub.'
    );
  });

  it('posts without syncing when the toggle is left off', async () => {
    createComment.mockResolvedValue({ comment_id: 'c-10' } as CommentRead);
    const onPosted = vi.fn();
    render(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        threadTargets={[target()]}
        onPosted={onPosted}
      />
    );
    const surface = await findSurface();
    act(() => {
      editorOf(surface).commands.setContent('Just a note');
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
    expect(syncThread).not.toHaveBeenCalled();
  });

  it('offers no sync on a reply', async () => {
    render(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        parentCommentId="c-1"
        threadTargets={[target()]}
      />
    );
    await screen.findByRole(
      'textbox',
      { name: 'Write a reply' },
      { timeout: 10_000 }
    );

    expect(screen.queryByRole('button', { name: /Sync to GitHub/ })).toBeNull();
  });

  it('adds a quote after what is already written', async () => {
    const { rerender } = render(
      <CommentComposer workspaceId="ws-1" issueId="iss-1" people={[]} />
    );
    const surface = await findSurface();
    act(() => {
      editorOf(surface).commands.setContent('My thoughts');
    });

    rerender(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        quote={{ markdown: '> The plan', id: 1 }}
      />
    );

    await waitFor(() => {
      expect(readMarkdown(editorOf(surface))).toBe('My thoughts\n\n> The plan');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Comment' })).toBeEnabled();
    });
  });

  it('applies each quote request once', async () => {
    const quote = { markdown: '> Once', id: 1 };
    const { rerender } = render(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        quote={quote}
      />
    );
    const surface = await findSurface();
    await waitFor(() => {
      expect(readMarkdown(editorOf(surface))).toBe('> Once');
    });

    rerender(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        quote={{ ...quote }}
        placeholder="Still here"
      />
    );

    expect(readMarkdown(editorOf(surface))).toBe('> Once');
  });

  it('quotes the same passage again on a new request', async () => {
    const { rerender } = render(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        quote={{ markdown: '> Again', id: 1 }}
      />
    );
    const surface = await findSurface();
    await waitFor(() => {
      expect(readMarkdown(editorOf(surface))).toBe('> Again');
    });

    rerender(
      <CommentComposer
        workspaceId="ws-1"
        issueId="iss-1"
        people={[]}
        quote={{ markdown: '> Again', id: 2 }}
      />
    );

    await waitFor(() => {
      expect(readMarkdown(editorOf(surface))).toBe('> Again\n\n> Again');
    });
  });
});
