/**
 * Peeking an issue into the workspace pane. Covers that the pane draws the
 * issue pane bare rather than inside a second frame, that the close handed to
 * it is the provider's stable one, that peeking the same issue again closes
 * it, that a different issue replaces the one showing, and that other content
 * keeps the shell's frame.
 */

import { act, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../components/shortcuts/ShortcutProvider';
import { PeekPane, PeekProvider } from '../components/workspace/PeekPane';
import { usePeek } from './usePeek';
import { usePeekIssue } from './usePeekIssue';

const closes: (() => void)[] = [];

vi.mock('../components/issues/IssuePeek', () => ({
  default: ({ issueId, onClose }: { issueId: string; onClose: () => void }) => {
    closes.push(onClose);
    return (
      <aside aria-label={`Issue ${issueId}`}>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </aside>
    );
  },
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/w/mine/team/ENG']}>
    <ShortcutProvider>
      <PeekProvider>
        {children}
        <PeekPane />
      </PeekProvider>
    </ShortcutProvider>
  </MemoryRouter>
);

describe('usePeekIssue', () => {
  it('draws the issue pane without the shell frame', () => {
    const { result } = renderHook(() => usePeekIssue(), { wrapper });

    act(() => {
      result.current.peekIssue({ id: 'issue-1', key: 'ENG-1' });
    });

    expect(result.current.peekedKey).toBe('ENG-1');
    expect(
      screen.getByRole('complementary', { name: 'Issue issue-1' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Close peek' })
    ).not.toBeInTheDocument();
  });

  it('closes through the stable close it hands the pane', () => {
    closes.length = 0;
    const { result, rerender } = renderHook(() => usePeekIssue(), { wrapper });

    act(() => {
      result.current.peekIssue({ id: 'issue-1', key: 'ENG-1' });
    });
    rerender();
    act(() => {
      screen.getByRole('button', { name: 'Close' }).click();
    });

    expect(new Set(closes).size).toBe(1);
    expect(result.current.peekedKey).toBeNull();
    expect(screen.queryByTestId('peek-pane')).not.toBeInTheDocument();
  });

  it('closes when the same issue is peeked again', () => {
    const { result } = renderHook(() => usePeekIssue(), { wrapper });

    act(() => {
      result.current.peekIssue({ id: 'issue-1', key: 'ENG-1' });
    });
    act(() => {
      result.current.peekIssue({ id: 'issue-1', key: 'ENG-1' });
    });

    expect(result.current.peekedKey).toBeNull();
  });

  it('replaces the issue showing with another', () => {
    const { result } = renderHook(() => usePeekIssue(), { wrapper });

    act(() => {
      result.current.peekIssue({ id: 'issue-1', key: 'ENG-1' });
    });
    act(() => {
      result.current.peekIssue({ id: 'issue-2', key: 'ENG-2' });
    });

    expect(result.current.peekedKey).toBe('ENG-2');
    expect(
      screen.getByRole('complementary', { name: 'Issue issue-2' })
    ).toBeInTheDocument();
  });
});

describe('a framed peek', () => {
  it('keeps the shell header and close button', () => {
    const { result } = renderHook(() => usePeek(), { wrapper });

    act(() => {
      result.current.openPeek({ key: 'note', label: 'Note', node: 'Hello' });
    });

    expect(
      screen.getByRole('complementary', { name: 'Note' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close peek' })
    ).toBeInTheDocument();
  });
});
