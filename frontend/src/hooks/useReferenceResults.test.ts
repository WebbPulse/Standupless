/**
 * The search behind the `#` reference picker. Covers that a query search
 * cannot answer sends nothing, that a burst of typing costs one request after
 * the pause, and that the answer arrives as the picker's list.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchListRead } from '../types/Api';
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

beforeEach(() => {
  vi.useFakeTimers();
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
    const { result } = renderHook(() => useReferenceResults('ws-1', 'ro'));
    act(() => {
      vi.advanceTimersByTime(REFERENCE_DEBOUNCE_MS * 2);
    });

    expect(searchAll).not.toHaveBeenCalled();
    expect(result.current).toEqual({ query: 'ro', items: [], loading: false });
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
});
