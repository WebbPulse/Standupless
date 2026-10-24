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

    const found = await listIssueDrafts('ws-1', 'i1');
    const empty = await listIssueDrafts('ws-1', 'i1');

    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/drafts', {
      query: { issue_id: 'i1' },
    });
    expect(found.map((row) => row.body)).toEqual(['Half a thought']);
    expect(empty).toEqual([]);
  });

  it('saves and discards on the issue route, naming a reply thread in the query', async () => {
    put.mockResolvedValue({ data: { issue_id: 'i1', body: 'Hi' } });
    del.mockResolvedValue({ data: undefined });

    await saveDraft('ws-1', 'i1', undefined, 'Hi');
    await saveDraft('ws-1', 'i1', 'c1', 'Hi');
    await deleteDraft('ws-1', 'i1', null);
    await deleteDraft('ws-1', 'i1', 'c1');

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
});
