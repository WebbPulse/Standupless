/**
 * The search behind the `#` reference picker. Covers that a query search
 * cannot answer sends nothing, that a burst of typing costs one request after
 * the pause, that the answer arrives as the picker's list with linked pull
 * requests last, and that a key query or a failed pull request read still
 * answers with the issues.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestHitRead, SearchListRead } from '../types/Api';
import {
  REFERENCE_DEBOUNCE_MS,
  useReferenceResults,
} from './useReferenceResults';

const searchAll =
  vi.fn<
    (
      workspaceId: string,
      q: string,
      options: unknown
    ) => Promise<SearchListRead>
  >();

vi.mock('../api/views', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchAll: (workspaceId: string, q: string, options: unknown) =>
    searchAll(workspaceId, q, options),
}));

const searchPullRequests =
  vi.fn<
    (
      workspaceId: string,
      q: string,
      options: unknown
    ) => Promise<PullRequestHitRead[]>
  >();

vi.mock('../api/pullRequests', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchPullRequests: (workspaceId: string, q: string, options: unknown) =>
    searchPullRequests(workspaceId, q, options),
}));

const PULL_REQUEST: PullRequestHitRead = {
  repository_full_name: 'acme/app',
  number: 12,
  title: 'Roadmap page',
  url: 'https://github.com/acme/app/pull/12',
  state: 'merged',
  author_login: 'octocat',
  issue_keys: ['ENG-1'],
  updated_at: '2026-10-23T00:00:00Z',
};

beforeEach(() => {
  vi.useFakeTimers();
  searchPullRequests.mockReset();
  searchPullRequests.mockResolvedValue([]);
  searchAll.mockReset();
  searchAll.mockResolvedValue({
    results: [],
    projects: [
      {
        project_id: 'prj-1',
        name: 'Roadmap',
        status: 'planned',
        health: null,
        icon: null,
        color: null,
        lead_id: null,
        team_ids: [],
        target_date: null,
        updated_at: '2026-10-23T00:00:00Z',
      },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useReferenceResults', () => {
  it('sends nothing for a query search cannot answer', () => {
    const { result } = renderHook(() => useReferenceResults('ws-1', 'r'));
    act(() => {
      vi.advanceTimersByTime(REFERENCE_DEBOUNCE_MS * 2);
    });

    expect(searchAll).not.toHaveBeenCalled();
    expect(result.current).toEqual({ query: 'r', items: [], loading: false });
  });

  it('sends nothing outside a workspace', () => {
    renderHook(() => useReferenceResults(null, 'roadmap'));
    act(() => {
      vi.advanceTimersByTime(REFERENCE_DEBOUNCE_MS * 2);
    });

    expect(searchAll).not.toHaveBeenCalled();
  });

  it('searches once typing pauses and lists the answer', async () => {
    const { result, rerender } = renderHook(
      ({ query }) => useReferenceResults('ws-1', query),
      { initialProps: { query: 'road' } }
    );
    rerender({ query: 'roadm' });
    rerender({ query: 'roadmap' });

    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFERENCE_DEBOUNCE_MS);
    });

    expect(searchAll).toHaveBeenCalledTimes(1);
    expect(searchAll).toHaveBeenCalledWith('ws-1', 'roadmap', { limit: 6 });
    expect(result.current.loading).toBe(false);
    expect(result.current.items).toEqual([
      {
        kind: 'project',
        id: 'prj-1',
        name: 'Roadmap',
        icon: null,
        color: null,
      },
    ]);
  });

  it('lists linked pull requests after everything else', async () => {
    searchPullRequests.mockResolvedValue([PULL_REQUEST]);
    const { result } = renderHook(() => useReferenceResults('ws-1', 'road'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFERENCE_DEBOUNCE_MS);
    });

    expect(searchPullRequests).toHaveBeenCalledWith('ws-1', 'road', {
      limit: 3,
    });
    expect(result.current.items.map((item) => item.kind)).toEqual([
      'project',
      'pull_request',
    ]);
  });

  it('answers a failed pull request read with the rest', async () => {
    searchPullRequests.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useReferenceResults('ws-1', 'road'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFERENCE_DEBOUNCE_MS);
    });

    expect(result.current.items.map((item) => item.kind)).toEqual(['project']);
  });

  it('asks for no pull requests for an issue key', async () => {
    renderHook(() => useReferenceResults('ws-1', 'ENG-12'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFERENCE_DEBOUNCE_MS);
    });

    expect(searchAll).toHaveBeenCalledTimes(1);
    expect(searchPullRequests).not.toHaveBeenCalled();
  });

  it('searches a bare pull request number', async () => {
    renderHook(() => useReferenceResults('ws-1', '4'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFERENCE_DEBOUNCE_MS);
    });

    expect(searchPullRequests).toHaveBeenCalledWith('ws-1', '4', { limit: 3 });
  });
});
