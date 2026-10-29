/**
 * The comment draft routes the composer saves through: one route per issue
 * with the reply thread named in the query, and a listing whose missing body
 * reads as no drafts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDraft, listIssueDrafts, saveDraft } from './drafts';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const put =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    put: (path: string, body?: unknown, options?: unknown) =>
      put(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const ISSUE = { kind: 'issue', id: 'i1' } as const;

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  del.mockReset();
});

describe('comment draft routes', () => {
  it('lists one issue drafts and reads a missing body as none', async () => {
    get.mockResolvedValueOnce({
      data: { drafts: [{ issue_id: 'i1', body: 'Half a thought' }] },
    });
    get.mockResolvedValueOnce({ data: undefined });

    const found = await listIssueDrafts('ws-1', ISSUE);
    const empty = await listIssueDrafts('ws-1', ISSUE);

    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/drafts', {
      query: { issue_id: 'i1' },
    });
    expect(found.map((row) => row.body)).toEqual(['Half a thought']);
    expect(empty).toEqual([]);
  });

  it('saves and discards on the issue route, naming a reply thread in the query', async () => {
    put.mockResolvedValue({ data: { issue_id: 'i1', body: 'Hi' } });
    del.mockResolvedValue({ data: undefined });

    await saveDraft('ws-1', ISSUE, undefined, 'Hi');
    await saveDraft('ws-1', ISSUE, 'c1', 'Hi');
    await deleteDraft('ws-1', ISSUE, null);
    await deleteDraft('ws-1', ISSUE, 'c1');

    expect(put).toHaveBeenNthCalledWith(
      1,
      '/workspaces/ws-1/drafts/i1',
      { body: 'Hi' },
      { query: {} }
    );
    expect(put).toHaveBeenNthCalledWith(
      2,
      '/workspaces/ws-1/drafts/i1',
      { body: 'Hi' },
      { query: { parent_comment_id: 'c1' } }
    );
    expect(del).toHaveBeenNthCalledWith(1, '/workspaces/ws-1/drafts/i1', {
      query: {},
    });
    expect(del).toHaveBeenNthCalledWith(2, '/workspaces/ws-1/drafts/i1', {
      query: { parent_comment_id: 'c1' },
    });
  });

  it('lists, saves and discards a document draft on its own route', async () => {
    get.mockResolvedValue({ data: { drafts: [] } });
    put.mockResolvedValue({ data: { document_id: 'd1', body: 'Hi' } });
    del.mockResolvedValue({ data: undefined });
    const document = { kind: 'document', id: 'd1' } as const;

    await listIssueDrafts('ws-1', document);
    await saveDraft('ws-1', document, 'c1', 'Hi');
    await deleteDraft('ws-1', document, null);

    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/drafts', {
      query: { document_id: 'd1' },
    });
    expect(put).toHaveBeenCalledWith(
      '/workspaces/ws-1/drafts/documents/d1',
      { body: 'Hi' },
      { query: { parent_comment_id: 'c1' } }
    );
    expect(del).toHaveBeenCalledWith('/workspaces/ws-1/drafts/documents/d1', {
      query: {},
    });
  });

  it('keeps an update reply draft on the update reply route of its project or initiative', async () => {
    get.mockResolvedValue({ data: { drafts: [] } });
    put.mockResolvedValue({ data: { update_id: 'u1', body: 'Hi' } });
    del.mockResolvedValue({ data: undefined });

    await listIssueDrafts('ws-1', {
      kind: 'project_update',
      projectId: 'p1',
      updateId: 'u1',
    });
    await saveDraft(
      'ws-1',
      { kind: 'project_update', projectId: 'p1', updateId: 'u1' },
      undefined,
      'Hi'
    );
    await deleteDraft(
      'ws-1',
      { kind: 'initiative_update', initiativeId: 'n1', updateId: 'u2' },
      null
    );

    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/drafts', {
      query: { update_id: 'u1' },
    });
    expect(put).toHaveBeenCalledWith(
      '/workspaces/ws-1/drafts/update-replies/projects/p1/u1',
      { body: 'Hi' },
      { query: {} }
    );
    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-1/drafts/update-replies/initiatives/n1/u2',
      { query: {} }
    );
  });
});
