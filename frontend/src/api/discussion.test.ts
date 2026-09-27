/**
 * The comment, reaction and attachment contract the frontend depends on:
 * `issue_id` as a query parameter on every single-comment and attachment
 * route, a reaction as a PUT and a DELETE on its own key rather than by id,
 * and the three-call upload in the order the contract fixes. Each is pinned
 * because a wrong path, verb or parameter name type-checks identically and
 * fails only against a live backend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReaction,
  appendAttachments,
  appendComments,
  attachmentDownloadPath,
  attachmentPath,
  attachmentsPath,
  commentPath,
  commitUpload,
  createComment,
  createUploadTicket,
  createUrlAttachment,
  deleteAttachment,
  deleteComment,
  emptyAttachmentPage,
  emptyCommentPage,
  getAttachmentDownload,
  getComment,
  getMediaTokens,
  issueCommentsPath,
  listAttachments,
  listComments,
  listReactions,
  mediaTokensPath,
  putUploadBytes,
  reactionsPath,
  removeReaction,
  updateComment,
  uploadAttachment,
  uploadTicketsPath,
  urlAttachmentsPath,
} from './discussion';
import type {
  AttachmentRead,
  CommentRead,
  ReactionGroup,
  UploadTicketRead,
} from '../types/Api';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const put =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const patch =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown, options?: unknown) =>
      post(path, body, options),
    put: (path: string, body?: unknown, options?: unknown) =>
      put(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const WS = 'ws-mine';
const ISSUE = 'iss-1';
const COMMENT = 'cmt-1';

/** One reaction group in exactly the shape the backend serialises. */
const group: ReactionGroup = {
  emoji: '👍',
  count: 2,
  user_ids: ['user-1', 'user-2'],
  reacted: true,
};

/** One comment in exactly the shape the backend serialises. */
const comment: CommentRead = {
  comment_id: COMMENT,
  issue_id: ISSUE,
  workspace_id: WS,
  team_id: 'proj-1',
  body: 'Looks right to me.',
  parent_comment_id: null,
  author_id: 'user-1',
  author: {
    user_id: 'user-1',
    display_name: 'Ada',
    email: 'ada@example.com',
  },
  mentions: [],
  reactions: [group],
  reply_count: 0,
  created_at: '2026-09-18T00:00:00Z',
  edited_at: null,
};

/** One file attachment in exactly the shape the backend serialises. */
const attachment: AttachmentRead = {
  attachment_id: 'att-1',
  issue_id: ISSUE,
  workspace_id: WS,
  team_id: 'proj-1',
  kind: 'file',
  title: 'trace.pdf',
  s3_key: 'workspaces/ws-mine/issues/iss-1/upl-1/trace.pdf',
  content_type: 'application/pdf',
  size_bytes: 1024,
  uploaded_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
};

/** One upload ticket, whose headers the PUT must send exactly. */
const ticket: UploadTicketRead = {
  upload_id: 'upl-1',
  ticket: 'signed-ticket',
  url: 'https://bucket.s3.amazonaws.com/signed',
  headers: { 'Content-Type': 'application/pdf', 'Content-Length': '1024' },
  s3_key: 'workspaces/ws-mine/issues/iss-1/upl-1/trace.pdf',
  max_bytes: 1024,
  expires_at: '2026-09-18T01:00:00Z',
};

beforeEach(() => {
  for (const spy of [get, post, put, patch, del]) spy.mockReset();
});

describe('the paths', () => {
  it('nests the thread under the issue and the comment beside it', () => {
    expect(issueCommentsPath(WS, ISSUE)).toBe(
      '/workspaces/ws-mine/issues/iss-1/comments'
    );
    expect(commentPath(WS, COMMENT)).toBe('/workspaces/ws-mine/comments/cmt-1');
  });

  it('keeps reactions on one route, since the key is the pair', () => {
    expect(reactionsPath(WS)).toBe('/workspaces/ws-mine/reactions');
  });

  it('separates the presign, the commit and the download routes', () => {
    expect(attachmentsPath(WS)).toBe('/workspaces/ws-mine/attachments');
    expect(urlAttachmentsPath(WS)).toBe('/workspaces/ws-mine/attachments/url');
    expect(uploadTicketsPath(WS)).toBe(
      '/workspaces/ws-mine/attachments/uploads'
    );
    expect(attachmentPath(WS, 'att-1')).toBe(
      '/workspaces/ws-mine/attachments/att-1'
    );
    expect(attachmentDownloadPath(WS, 'att-1')).toBe(
      '/workspaces/ws-mine/attachments/att-1/download'
    );
  });
});

describe('comments', () => {
  it('pages the thread oldest first', async () => {
    get.mockResolvedValue({
      data: { comments: [comment], next_cursor: 'cur-2' },
    });

    const page = await listComments(WS, ISSUE, { cursor: 'cur-1', limit: 50 });

    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1/comments',
      { query: { cursor: 'cur-1', limit: 50 } }
    );
    expect(page.comments).toEqual([comment]);
    expect(page.next_cursor).toBe('cur-2');
  });

  it('reads a body missing its envelope as an empty page', async () => {
    get.mockResolvedValue({ data: undefined });

    await expect(listComments(WS, ISSUE)).resolves.toEqual({
      comments: [],
      next_cursor: null,
    });
  });

  it('posts a reply carrying its parent, which is one level deep', async () => {
    post.mockResolvedValue({ data: comment });

    await createComment(WS, ISSUE, {
      body: 'Agreed.',
      parent_comment_id: COMMENT,
    });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1/comments',
      { body: 'Agreed.', parent_comment_id: COMMENT },
      undefined
    );
  });

  it('reads one comment with the issue that locates its partition', async () => {
    get.mockResolvedValue({ data: comment });

    await getComment(WS, COMMENT, ISSUE);

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/comments/cmt-1', {
      query: { issue_id: ISSUE },
    });
  });

  it('sends the issue in the body when editing, not the query', async () => {
    patch.mockResolvedValue({ data: comment });

    await updateComment(WS, COMMENT, ISSUE, 'Edited.');

    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-mine/comments/cmt-1',
      { issue_id: ISSUE, body: 'Edited.' },
      undefined
    );
  });

  it('sends the issue in the query when deleting', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteComment(WS, COMMENT, ISSUE);

    expect(del).toHaveBeenCalledWith('/workspaces/ws-mine/comments/cmt-1', {
      query: { issue_id: ISSUE },
    });
  });
});

describe('reactions', () => {
  it('reads the groups on a target by id and kind', async () => {
    get.mockResolvedValue({ data: { reactions: [group] } });

    await expect(listReactions(WS, COMMENT, 'comment')).resolves.toEqual([
      group,
    ]);
    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/reactions', {
      query: { target_id: COMMENT, target_kind: 'comment' },
    });
  });

  it('reads a body missing its envelope as no reactions', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listReactions(WS, ISSUE, 'issue')).resolves.toEqual([]);
  });

  it('adds a reaction with a put, since the caller knows the key', async () => {
    put.mockResolvedValue({ data: group });

    await addReaction(WS, {
      target_id: COMMENT,
      target_kind: 'comment',
      emoji: '👍',
    });

    expect(put).toHaveBeenCalledWith(
      '/workspaces/ws-mine/reactions',
      { target_id: COMMENT, target_kind: 'comment', emoji: '👍' },
      undefined
    );
  });

  it('removes a reaction by the whole pair in the query', async () => {
    del.mockResolvedValue({ data: undefined });

    await removeReaction(WS, {
      target_id: ISSUE,
      target_kind: 'issue',
      emoji: '🎉',
    });

    expect(del).toHaveBeenCalledWith('/workspaces/ws-mine/reactions', {
      query: { target_id: ISSUE, target_kind: 'issue', emoji: '🎉' },
    });
  });
});

describe('attachments', () => {
  it('lists by issue, which the query rather than the path carries', async () => {
    get.mockResolvedValue({
      data: { attachments: [attachment], next_cursor: null },
    });

    const page = await listAttachments(WS, ISSUE, { limit: 20 });

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/attachments', {
      query: { issue_id: ISSUE, limit: 20 },
    });
    expect(page.attachments).toEqual([attachment]);
  });

  it('reads a body missing its envelope as an empty page', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listAttachments(WS, ISSUE)).resolves.toEqual({
      attachments: [],
      next_cursor: null,
    });
  });

  it('creates a url attachment on its own route', async () => {
    post.mockResolvedValue({ data: { ...attachment, kind: 'url' } });

    await createUrlAttachment(WS, {
      issue_id: ISSUE,
      url: 'https://example.com/spec',
      title: 'The spec',
    });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/attachments/url',
      { issue_id: ISSUE, url: 'https://example.com/spec', title: 'The spec' },
      undefined
    );
  });

  it('declares the bytes when minting a ticket', async () => {
    post.mockResolvedValue({ data: ticket });

    await createUploadTicket(WS, {
      issue_id: ISSUE,
      filename: 'trace.pdf',
      content_type: 'application/pdf',
      size_bytes: 1024,
    });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/attachments/uploads',
      {
        issue_id: ISSUE,
        filename: 'trace.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
      },
      undefined
    );
  });

  it('commits by upload id and signed ticket, never by the key', async () => {
    post.mockResolvedValue({ data: attachment });

    await commitUpload(WS, ISSUE, ticket, 'trace.pdf');

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/attachments',
      {
        issue_id: ISSUE,
        upload_id: 'upl-1',
        ticket: 'signed-ticket',
        title: 'trace.pdf',
      },
      undefined
    );
  });

  it('omits a blank title on the commit rather than sending it empty', async () => {
    post.mockResolvedValue({ data: attachment });

    await commitUpload(WS, ISSUE, ticket, '');

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/attachments',
      { issue_id: ISSUE, upload_id: 'upl-1', ticket: 'signed-ticket' },
      undefined
    );
  });

  it('mints a download per click rather than holding one', async () => {
    get.mockResolvedValue({
      data: { url: 'https://signed', expires_at: '2026-09-18T00:05:00Z' },
    });

    await expect(getAttachmentDownload(WS, 'att-1', ISSUE)).resolves.toEqual({
      url: 'https://signed',
      expires_at: '2026-09-18T00:05:00Z',
    });
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-mine/attachments/att-1/download',
      { query: { issue_id: ISSUE } }
    );
  });

  it('reads the media tokens of one issue', async () => {
    get.mockResolvedValue({
      data: { tokens: { 'att-1': 'tok' }, expires_at: '2026-09-18T01:00:00Z' },
    });

    await expect(getMediaTokens(WS, ISSUE)).resolves.toEqual({
      tokens: { 'att-1': 'tok' },
      expires_at: '2026-09-18T01:00:00Z',
    });
    expect(mediaTokensPath(WS)).toBe('/workspaces/ws-mine/attachments/media');
    expect(get.mock.calls[0]?.[0]).toBe(
      '/workspaces/ws-mine/attachments/media'
    );
  });

  it('deletes with the issue in the query', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteAttachment(WS, 'att-1', ISSUE);

    expect(del).toHaveBeenCalledWith('/workspaces/ws-mine/attachments/att-1', {
      query: { issue_id: ISSUE },
    });
  });
});

/** What a fake request was opened, headed and sent with. */
interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Installs a stand in XMLHttpRequest that answers every send with one status,
 * after reporting upload progress, and records what each request carried.
 */
const fakeXhr = (status: number, order?: string[]): SentRequest[] => {
  const sent: SentRequest[] = [];
  /** One fake request. */
  class FakeRequest {
    status = 0;
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
      onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private record: SentRequest = {
      method: '',
      url: '',
      headers: {},
      body: null,
    };

    /** Records the method and target. */
    open(method: string, url: string): void {
      this.record.method = method;
      this.record.url = url;
    }

    /** Records one header. */
    setRequestHeader(name: string, value: string): void {
      this.record.headers[name] = value;
    }

    /** Reports half then all of the bytes, then answers. */
    send(body: unknown): void {
      this.record.body = body;
      sent.push(this.record);
      order?.push('PUT');
      queueMicrotask(() => {
        this.upload.onprogress?.({
          loaded: 512,
          total: 1024,
          lengthComputable: true,
        } as ProgressEvent);
        this.status = status;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeRequest);
  return sent;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the browser put', () => {
  it('sends the headers the ticket named, and no bearer token', async () => {
    const sent = fakeXhr(200);

    const file = new Blob(['x'], { type: 'application/pdf' });
    await putUploadBytes(ticket, file);

    expect(sent).toEqual([
      {
        method: 'PUT',
        url: ticket.url,
        headers: { 'Content-Type': 'application/pdf' },
        body: file,
      },
    ]);
  });

  it('reports how far the bytes have gone', async () => {
    fakeXhr(200);
    const progress = vi.fn();

    await putUploadBytes(ticket, new Blob(['x']), progress);

    expect(progress).toHaveBeenCalledWith({ loaded: 512, total: 1024 });
  });

  it('raises when the bucket refuses the put', async () => {
    fakeXhr(403);

    await expect(putUploadBytes(ticket, new Blob(['x']))).rejects.toThrow(
      '403'
    );
  });
});

describe('the whole upload', () => {
  it('mints, puts and only then commits with the ticket', async () => {
    const order: string[] = [];
    post.mockImplementation((path: string) => {
      order.push(path);
      return Promise.resolve({
        data: path.endsWith('/uploads') ? ticket : attachment,
      });
    });
    fakeXhr(200, order);

    const file = new File(['x'], 'trace.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 1024 });

    await expect(uploadAttachment(WS, ISSUE, file)).resolves.toEqual(
      attachment
    );

    expect(order).toEqual([
      '/workspaces/ws-mine/attachments/uploads',
      'PUT',
      '/workspaces/ws-mine/attachments',
    ]);
    expect(post).toHaveBeenLastCalledWith(
      '/workspaces/ws-mine/attachments',
      { issue_id: ISSUE, upload_id: 'upl-1', ticket: 'signed-ticket' },
      undefined
    );
  });

  it('never commits when the bytes were refused', async () => {
    post.mockResolvedValue({ data: ticket });
    fakeXhr(413);

    const file = new File(['x'], 'trace.pdf', { type: 'application/pdf' });

    await expect(uploadAttachment(WS, ISSUE, file)).rejects.toThrow('413');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('the paging helpers', () => {
  it('starts from an empty page of each kind', () => {
    expect(emptyCommentPage()).toEqual({ comments: [], next_cursor: null });
    expect(emptyAttachmentPage()).toEqual({
      attachments: [],
      next_cursor: null,
    });
  });

  it('appends without repeating a row the cursor overlapped', () => {
    const second: CommentRead = { ...comment, comment_id: 'cmt-2' };

    expect(appendComments([comment], [comment, second])).toEqual([
      comment,
      second,
    ]);
  });

  it('appends attachments without repeating a row', () => {
    const second: AttachmentRead = { ...attachment, attachment_id: 'att-2' };

    expect(appendAttachments([attachment], [attachment, second])).toEqual([
      attachment,
      second,
    ]);
  });
});
