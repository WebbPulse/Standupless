/**
 * The issue import contract: the routes each call spends, that an import id
 * is escaped into its path, and the list read's tolerance of a bad body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getIssueImport,
  listIssueImports,
  previewIssueImport,
  startIssueImport,
} from './imports';
import type { IssueImportRequest } from '../types/Api';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

const BODY: IssueImportRequest = {
  team_id: 't1',
  preset: 'jira',
  csv: 'Summary\nOne\n',
  file_name: 'jira.csv',
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('the issue import routes', () => {
  it('dry runs a file on the preview route', async () => {
    post.mockResolvedValue({ data: { total_rows: 1 } });

    await expect(previewIssueImport('ws1', BODY)).resolves.toEqual({
      total_rows: 1,
    });
    expect(post).toHaveBeenCalledWith('/workspaces/ws1/imports/preview', BODY);
  });

  it('starts an import', async () => {
    post.mockResolvedValue({ data: { import_id: 'i1', status: 'queued' } });

    await expect(startIssueImport('ws1', BODY)).resolves.toEqual({
      import_id: 'i1',
      status: 'queued',
    });
    expect(post).toHaveBeenCalledWith('/workspaces/ws1/imports', BODY);
  });

  it('lists the imports from the items key', async () => {
    get.mockResolvedValue({ data: { items: [{ import_id: 'i1' }] } });

    await expect(listIssueImports('ws1')).resolves.toEqual([
      { import_id: 'i1' },
    ]);
    expect(get).toHaveBeenCalledWith('/workspaces/ws1/imports', undefined);
  });

  it('answers an empty list for a malformed body', async () => {
    get.mockResolvedValue({ data: { items: 'nope' } });

    await expect(listIssueImports('ws1')).resolves.toEqual([]);
  });

  it('escapes the import id into the job path', async () => {
    get.mockResolvedValue({ data: { import_id: 'a b' } });

    await getIssueImport('ws1', 'a b');
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws1/imports/a%20b',
      undefined
    );
  });
});
