/**
 * The workspace export contract: the routes each call spends, that an export
 * id is escaped into its path, and the list read's tolerance of a bad body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkspaceExport,
  listWorkspaceExports,
  startWorkspaceExport,
} from './exports';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('the workspace export routes', () => {
  it('starts an export with the masking choice', async () => {
    post.mockResolvedValue({ data: { export_id: 'e1', status: 'queued' } });

    await expect(
      startWorkspaceExport('ws1', { include_emails: false })
    ).resolves.toEqual({ export_id: 'e1', status: 'queued' });
    expect(post).toHaveBeenCalledWith('/workspaces/ws1/exports', {
      include_emails: false,
    });
  });

  it('lists the exports from the items key', async () => {
    get.mockResolvedValue({ data: { items: [{ export_id: 'e1' }] } });

    await expect(listWorkspaceExports('ws1')).resolves.toEqual([
      { export_id: 'e1' },
    ]);
    expect(get).toHaveBeenCalledWith('/workspaces/ws1/exports', undefined);
  });

  it('answers an empty list for a malformed body', async () => {
    get.mockResolvedValue({ data: { items: 'nope' } });

    await expect(listWorkspaceExports('ws1')).resolves.toEqual([]);
  });

  it('escapes the export id into the job path', async () => {
    get.mockResolvedValue({ data: { export_id: 'a b' } });

    await getWorkspaceExport('ws1', 'a b');
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws1/exports/a%20b',
      undefined
    );
  });
});
