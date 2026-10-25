/**
 * A person's folds on a list that is not a saved view. Covers that the server
 * read lays the folds in, that a toggle and a clear write the whole set, that
 * no list key reads or writes nothing, and that a browser entry left from
 * before folds moved to the server is carried over once and then dropped.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyFoldsKey, useListFolds } from './useListFolds';

const getListFolds =
  vi.fn<
    (
      workspaceId: string,
      listKey: string
    ) => Promise<{ list_key: string; collapsed_groups: string[] }>
  >();
const putListFolds =
  vi.fn<
    (
      workspaceId: string,
      listKey: string,
      collapsed: readonly string[]
    ) => Promise<{ list_key: string; collapsed_groups: string[] }>
  >();

vi.mock('../api/views', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getListFolds: (workspaceId: string, listKey: string) =>
    getListFolds(workspaceId, listKey),
  putListFolds: (
    workspaceId: string,
    listKey: string,
    collapsed: readonly string[]
  ) => putListFolds(workspaceId, listKey, collapsed),
}));

beforeEach(() => {
  getListFolds.mockReset();
  putListFolds.mockReset();
  putListFolds.mockImplementation((_workspace, listKey, collapsed) =>
    Promise.resolve({ list_key: listKey, collapsed_groups: [...collapsed] })
  );
});

describe('useListFolds', () => {
  it('lays in the folds the server keeps for the list', async () => {
    getListFolds.mockResolvedValue({
      list_key: 'team:t1',
      collapsed_groups: ['done', 'lane/high'],
    });
    const { result } = renderHook(() => useListFolds('ws', 'team:t1'));

    await waitFor(() => {
      expect(result.current.collapsed.has('done')).toBe(true);
    });
    expect(result.current.collapsed.has('lane/high')).toBe(true);
    expect(getListFolds).toHaveBeenCalledWith('ws', 'team:t1');
    expect(putListFolds).not.toHaveBeenCalled();
  });

  it('writes the whole set on a toggle and an empty one on a clear', async () => {
    getListFolds.mockResolvedValue({
      list_key: 'cycle:c1',
      collapsed_groups: [],
    });
    const { result } = renderHook(() => useListFolds('ws', 'cycle:c1'));
    await waitFor(() => {
      expect(getListFolds).toHaveBeenCalled();
    });

    act(() => {
      result.current.toggle('todo');
    });
    expect(result.current.collapsed.has('todo')).toBe(true);
    await waitFor(() => {
      expect(putListFolds).toHaveBeenLastCalledWith('ws', 'cycle:c1', ['todo']);
    });

    act(() => {
      result.current.clear();
    });
    expect(result.current.collapsed.size).toBe(0);
    await waitFor(() => {
      expect(putListFolds).toHaveBeenLastCalledWith('ws', 'cycle:c1', []);
    });
  });

  it('reads and writes nothing without a list key', () => {
    const { result } = renderHook(() => useListFolds('ws', undefined));

    act(() => {
      result.current.toggle('todo');
    });
    expect(result.current.collapsed.size).toBe(0);
    expect(getListFolds).not.toHaveBeenCalled();
    expect(putListFolds).not.toHaveBeenCalled();
  });

  it('carries a browser entry over once when the server has none', async () => {
    const storageKey = legacyFoldsKey('ws', 'mine-assigned');
    globalThis.localStorage.setItem(storageKey, JSON.stringify(['done', 7]));
    getListFolds.mockResolvedValue({
      list_key: 'mine-assigned',
      collapsed_groups: [],
    });
    const { result } = renderHook(() => useListFolds('ws', 'mine-assigned'));

    expect(globalThis.localStorage.getItem(storageKey)).toBeNull();
    await waitFor(() => {
      expect(putListFolds).toHaveBeenCalledWith('ws', 'mine-assigned', [
        'done',
      ]);
    });
    expect(result.current.collapsed.has('done')).toBe(true);
  });

  it('prefers the server over a browser entry and still drops the entry', async () => {
    const storageKey = legacyFoldsKey('ws', 'project:p1');
    globalThis.localStorage.setItem(storageKey, JSON.stringify(['old']));
    getListFolds.mockResolvedValue({
      list_key: 'project:p1',
      collapsed_groups: ['new'],
    });
    const { result } = renderHook(() => useListFolds('ws', 'project:p1'));

    await waitFor(() => {
      expect(result.current.collapsed.has('new')).toBe(true);
    });
    expect(result.current.collapsed.has('old')).toBe(false);
    expect(globalThis.localStorage.getItem(storageKey)).toBeNull();
    expect(putListFolds).not.toHaveBeenCalled();
  });
});
