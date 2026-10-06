/**
 * The workspace workflow contract: statuses and labels every team inherits are
 * read and written under the workspace path, never a team's, and a list reads
 * its plural envelope and falls back to empty on a malformed body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceLabel,
  createWorkspaceStatus,
  deleteWorkspaceLabel,
  deleteWorkspaceStatus,
  listWorkspaceLabels,
  listWorkspaceStatuses,
  updateWorkspaceLabel,
  updateWorkspaceStatus,
  workspaceLabelsPath,
  workspaceStatusesPath,
} from './workflow';

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

const WS = 'ws-mine';

/** A workspace status in the shape the backend serialises. */
const status = {
  id: 'st-1',
  name: 'In review',
  category: 'started' as const,
  position: 2,
  scope: 'workspace' as const,
};

/** A workspace label in the shape the backend serialises. */
const label = {
  id: 'lb-1',
  name: 'Security',
  color: '#8b5cd6',
  scope: 'workspace' as const,
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('the workspace paths', () => {
  it('sit under the workspace, not a team', () => {
    expect(workspaceStatusesPath(WS)).toBe('/workspaces/ws-mine/statuses');
    expect(workspaceLabelsPath(WS)).toBe('/workspaces/ws-mine/labels');
  });
});

describe('the workspace statuses', () => {
  it('reads the statuses envelope and passes the signal on', async () => {
    get.mockResolvedValue({ data: { statuses: [status] } });
    const signal = new AbortController().signal;

    await expect(listWorkspaceStatuses(WS, signal)).resolves.toEqual([status]);
    expect(get).toHaveBeenCalledWith(workspaceStatusesPath(WS), { signal });
  });

  it('answers an empty list for a malformed body', async () => {
    get.mockResolvedValue({ data: {} });
    await expect(listWorkspaceStatuses(WS)).resolves.toEqual([]);
    expect(get).toHaveBeenCalledWith(workspaceStatusesPath(WS), undefined);
  });

  it('creates, updates and deletes by id', async () => {
    post.mockResolvedValue({ data: status });
    patch.mockResolvedValue({ data: status });
    del.mockResolvedValue({ data: undefined });

    await expect(
      createWorkspaceStatus(WS, { name: 'In review', category: 'started' })
    ).resolves.toEqual(status);
    await expect(
      updateWorkspaceStatus(WS, 'st-1', { position: 3 })
    ).resolves.toEqual(status);
    await deleteWorkspaceStatus(WS, 'st-1');

    expect(post).toHaveBeenCalledWith(
      workspaceStatusesPath(WS),
      { name: 'In review', category: 'started' },
      undefined
    );
    expect(patch).toHaveBeenCalledWith(
      `${workspaceStatusesPath(WS)}/st-1`,
      { position: 3 },
      undefined
    );
    expect(del).toHaveBeenCalledWith(
      `${workspaceStatusesPath(WS)}/st-1`,
      undefined
    );
  });
});

describe('the workspace labels', () => {
  it('reads the labels envelope', async () => {
    get.mockResolvedValue({ data: { labels: [label] } });
    await expect(listWorkspaceLabels(WS)).resolves.toEqual([label]);
    get.mockResolvedValue({ data: null });
    await expect(listWorkspaceLabels(WS)).resolves.toEqual([]);
  });

  it('creates, updates and deletes by id', async () => {
    post.mockResolvedValue({ data: label });
    patch.mockResolvedValue({ data: label });
    del.mockResolvedValue({ data: undefined });

    await createWorkspaceLabel(WS, { name: 'Security', color: '#8b5cd6' });
    await updateWorkspaceLabel(WS, 'lb-1', { color: '#123abc' });
    await deleteWorkspaceLabel(WS, 'lb-1');

    expect(post).toHaveBeenCalledWith(
      workspaceLabelsPath(WS),
      { name: 'Security', color: '#8b5cd6' },
      undefined
    );
    expect(patch).toHaveBeenCalledWith(
      `${workspaceLabelsPath(WS)}/lb-1`,
      { color: '#123abc' },
      undefined
    );
    expect(del).toHaveBeenCalledWith(
      `${workspaceLabelsPath(WS)}/lb-1`,
      undefined
    );
  });
});
