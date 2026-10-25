/**
 * Holds the threads pinned to passages of one issue's description, for the
 * description and the timeline that sit side by side under it.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AnchoredThread } from '../components/editor/commentAnchors';
import {
  PassageThreadsContext,
  type PassageThreads,
} from './PassageThreadsContextDefinition';

/** How long a thread or passage stays marked after it was pointed at. */
const ACTIVE_MS = 2500;

/** The key that tells two thread lists apart, so an unchanged list is kept. */
const threadsKey = (threads: AnchoredThread[]): string =>
  JSON.stringify(threads.map((thread) => [thread.commentId, thread.anchor]));

/** The element id a comment's card carries, as its link hash names it. */
const threadElementId = (commentId: string): string => `comment-${commentId}`;

/** Scrolls an element into view when the platform can. */
const reveal = (node: Element | null): void => {
  if (node !== null && typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
};

/** Provides one issue's anchored threads to the description and the timeline. */
export const PassageThreadsProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [threads, setThreadList] = useState<AnchoredThread[]>([]);
  const [located, setLocatedSet] = useState<ReadonlySet<string> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const shownKey = useRef('[]');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  const setThreads = useCallback((next: AnchoredThread[]): void => {
    const key = threadsKey(next);
    if (key === shownKey.current) return;
    shownKey.current = key;
    setThreadList(next);
  }, []);

  const setLocated = useCallback((commentIds: string[]): void => {
    setLocatedSet(new Set(commentIds));
  }, []);

  const activate = useCallback((commentId: string): void => {
    setActiveId(commentId);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setActiveId(null);
    }, ACTIVE_MS);
  }, []);

  const showThread = useCallback(
    (commentId: string): void => {
      activate(commentId);
      const node = document.getElementById(threadElementId(commentId));
      reveal(node);
      if (node instanceof HTMLElement) node.focus({ preventScroll: true });
    },
    [activate]
  );

  const showPassage = useCallback(
    (commentId: string): void => {
      activate(commentId);
      reveal(
        document.querySelector(
          `[data-comment-anchor="${CSS.escape(commentId)}"]`
        )
      );
    },
    [activate]
  );

  const value = useMemo<PassageThreads>(
    () => ({
      threads,
      setThreads,
      located,
      setLocated,
      activeId,
      showThread,
      showPassage,
    }),
    [
      threads,
      setThreads,
      located,
      setLocated,
      activeId,
      showThread,
      showPassage,
    ]
  );

  return (
    <PassageThreadsContext.Provider value={value}>
      {children}
    </PassageThreadsContext.Provider>
  );
};

export default PassageThreadsProvider;
