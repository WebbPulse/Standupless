/**
 * Context object for the threads pinned to passages of an issue's description,
 * kept apart from the provider so the provider file exports only components and
 * stays refresh safe.
 *
 * The timeline reports the open anchored threads, the description draws their
 * passages and reports which it found, and either side can point at the other:
 * a passage scrolls to its thread, and a thread's quote scrolls to its passage.
 */

import { createContext, useContext } from 'react';
import type { AnchoredThread } from '../components/editor/commentAnchors';

/** What the description and the timeline share about anchored threads. */
export interface PassageThreads {
  /** The open threads pinned to the description. */
  threads: AnchoredThread[];
  /** Reports the open anchored threads, from the timeline. */
  setThreads: (threads: AnchoredThread[]) => void;
  /** The threads whose passage the description still holds, or null before it has looked. */
  located: ReadonlySet<string> | null;
  /** Reports which passages the description found. */
  setLocated: (commentIds: string[]) => void;
  /** The thread being pointed at, whose passage and card are drawn stronger. */
  activeId: string | null;
  /** Scrolls to a thread and focuses it, marking it active for a moment. */
  showThread: (commentId: string) => void;
  /** Scrolls to a thread's passage in the description, marking it active for a moment. */
  showPassage: (commentId: string) => void;
}

/** The shared state, or null outside an issue that pins threads to passages. */
export const PassageThreadsContext = createContext<PassageThreads | null>(null);

/** The issue's anchored threads, or null when nothing provides them. */
export const usePassageThreads = (): PassageThreads | null =>
  useContext(PassageThreadsContext);
