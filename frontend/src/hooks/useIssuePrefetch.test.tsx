/**
 * The issue prefetch on a row or card. A rest of the pointer or focus starts
 * the issue page's own read under its own query key, a sweep across a list
 * that never rests reads nothing, and outside a workspace nothing is read.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolledQueryContext } from '@webbpulse/api-client/react';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../contexts/WorkspaceContextDefinition';
import type { WorkspaceRead } from '../types/Api';
import { issueKey } from '../lib/queryKeys';
import { ISSUE_PREFETCH_DELAY_MS, useIssuePrefetch } from './useIssuePrefetch';

const prefetch =
  vi.fn<
    (
      key: readonly unknown[],
      fetcher: (context: PolledQueryContext) => Promise<unknown>,
      options?: unknown
    ) => Promise<void>
  >();
const getIssueByKey =
  vi.fn<
    (workspaceId: string, key: string, context: unknown) => Promise<unknown>
  >();

vi.mock('@webbpulse/api-client/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prefetchPolledQuery: (
    key: readonly unknown[],
    fetcher: (context: PolledQueryContext) => Promise<unknown>,
    options?: unknown
  ) => prefetch(key, fetcher, options),
}));

vi.mock('../api/issues', () => ({
  getIssueByKey: (workspaceId: string, key: string, context: unknown) =>
    getIssueByKey(workspaceId, key, context),
}));

const WS = 'ws-1';

/** The workspace context a page under `/w/:slug` sees. */
const workspaceValue = (id: string): WorkspaceContextType => ({
  workspace: { id, slug: 'acme' } as WorkspaceRead,
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
});

/** A link that prefetches `issueKeyValue`, as a row or card renders it. */
const Row: React.FC<{ issueKeyValue: string; focused?: boolean }> = ({
  issueKeyValue,
  focused = false,
}) => {
  const handlers = useIssuePrefetch(issueKeyValue, focused);
  return (
    <a href={`#${issueKeyValue}`} {...handlers}>
      {issueKeyValue}
    </a>
  );
};

/** Renders a row inside a workspace, or outside one when `id` is null. */
const renderRow = (
  id: string | null,
  props: { issueKeyValue: string; focused?: boolean }
) =>
  render(
    id === null ? (
      <Row {...props} />
    ) : (
      <WorkspaceContext.Provider value={workspaceValue(id)}>
        <Row {...props} />
      </WorkspaceContext.Provider>
    )
  );

beforeEach(() => {
  vi.useFakeTimers();
  prefetch.mockReset();
  prefetch.mockResolvedValue(undefined);
  getIssueByKey.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useIssuePrefetch', () => {
  it('reads the issue once the pointer rests on the link', async () => {
    renderRow(WS, { issueKeyValue: 'ENG-1' });

    fireEvent.mouseEnter(screen.getByText('ENG-1'));
    expect(prefetch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(ISSUE_PREFETCH_DELAY_MS);
    });

    expect(prefetch).toHaveBeenCalledTimes(1);
    const [key, fetcher] = prefetch.mock.calls[0] ?? [];
    expect(key).toEqual(issueKey(WS, 'ENG-1'));
    const context: PolledQueryContext = {
      signal: new AbortController().signal,
      etag: undefined,
      headers: {},
    };
    await fetcher?.(context);
    expect(getIssueByKey).toHaveBeenCalledWith(WS, 'ENG-1', context);
  });

  it('reads nothing when the pointer leaves before resting', () => {
    renderRow(WS, { issueKeyValue: 'ENG-2' });
    const link = screen.getByText('ENG-2');

    fireEvent.mouseEnter(link);
    act(() => {
      vi.advanceTimersByTime(ISSUE_PREFETCH_DELAY_MS - 10);
    });
    fireEvent.mouseLeave(link);
    act(() => {
      vi.advanceTimersByTime(ISSUE_PREFETCH_DELAY_MS * 2);
    });

    expect(prefetch).not.toHaveBeenCalled();
  });

  it('reads the issue once keyboard focus rests on the link', () => {
    renderRow(WS, { issueKeyValue: 'ENG-3' });
    const link = screen.getByText('ENG-3');

    fireEvent.focus(link);
    act(() => {
      vi.advanceTimersByTime(ISSUE_PREFETCH_DELAY_MS);
    });
    fireEvent.blur(link);

    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it('reads the issue a list moves its own focus to', () => {
    const { rerender } = renderRow(WS, { issueKeyValue: 'ENG-4' });
    expect(prefetch).not.toHaveBeenCalled();

    rerender(
      <WorkspaceContext.Provider value={workspaceValue(WS)}>
        <Row issueKeyValue="ENG-4" focused />
      </WorkspaceContext.Provider>
    );
    act(() => {
      vi.advanceTimersByTime(ISSUE_PREFETCH_DELAY_MS);
    });

    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch.mock.calls[0]?.[0]).toEqual(issueKey(WS, 'ENG-4'));
  });

  it('reads nothing outside a workspace', () => {
    renderRow(null, { issueKeyValue: 'ENG-5' });

    fireEvent.mouseEnter(screen.getByText('ENG-5'));
    act(() => {
      vi.advanceTimersByTime(ISSUE_PREFETCH_DELAY_MS);
    });

    expect(prefetch).not.toHaveBeenCalled();
  });

  it('drops a pending read when the row unmounts', () => {
    const { unmount } = renderRow(WS, { issueKeyValue: 'ENG-6' });

    fireEvent.mouseEnter(screen.getByText('ENG-6'));
    unmount();
    act(() => {
      vi.advanceTimersByTime(ISSUE_PREFETCH_DELAY_MS);
    });

    expect(prefetch).not.toHaveBeenCalled();
  });
});
