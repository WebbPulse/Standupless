/**
 * The document routes the frontend depends on: the paths under a project, an
 * initiative, the workspace and an issue, and the plural keys the list bodies
 * carry. A wrong path or key type-checks identically and fails only against a
 * live backend, so each is pinned here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocumentVersions,
  listDocuments,
  listIssueDocuments,
  listWorkspaceDocuments,
  updateDocument,
} from './documents';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
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
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const WS = 'ws-1';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('document routes', () => {
  it('lists through the parent and reads the documents key', async () => {
    get.mockResolvedValue({ data: { documents: [{ document_id: 'd1' }] } });

    const project = await listDocuments(WS, 'project', 'p1');
    const initiative = await listDocuments(WS, 'initiative', 'i1');

    expect(project).toEqual([{ document_id: 'd1' }]);
    expect(initiative).toHaveLength(1);
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/workspaces/ws-1/projects/p1/documents',
      '/workspaces/ws-1/initiatives/i1/documents',
    ]);
  });

  it('answers an empty list for a body without documents', async () => {
    get.mockResolvedValue({ data: {} });

    expect(await listWorkspaceDocuments(WS)).toEqual([]);
    expect(await listIssueDocuments(WS, 'issue-1')).toEqual([]);
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/workspaces/ws-1/documents',
      '/workspaces/ws-1/issues/issue-1/documents',
    ]);
  });

  it('creates under the parent and edits by the document id', async () => {
    post.mockResolvedValue({ data: { document_id: 'd1' } });
    patch.mockResolvedValue({ data: { document_id: 'd1' } });
    get.mockResolvedValue({ data: { versions: [{ version_id: 'v1' }] } });
    del.mockResolvedValue({ data: undefined });

    await createDocument(WS, 'initiative', 'i1', { title: 'Plan' });
    await updateDocument(WS, 'd1', {
      body: 'Text',
      base_updated_at: '2026-10-10T00:00:00Z',
    });
    const versions = await listDocumentVersions(WS, 'd1');
    await deleteDocument(WS, 'd1');

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-1/initiatives/i1/documents',
      { title: 'Plan' },
      undefined
    );
    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-1/documents/d1',
      { body: 'Text', base_updated_at: '2026-10-10T00:00:00Z' },
      undefined
    );
    expect(versions).toEqual([{ version_id: 'v1' }]);
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-1/documents/d1/versions',
      undefined
    );
    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-1/documents/d1',
      undefined
    );
  });

  it('reads one document by id', async () => {
    get.mockResolvedValue({ data: { document_id: 'd1', body: 'Hi' } });

    const read = await getDocument(WS, 'd1');

    expect(read.body).toBe('Hi');
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-1/documents/d1',
      undefined
    );
  });
});
