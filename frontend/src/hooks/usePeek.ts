/**
 * The right-side peek pane: an outlet the workspace shell renders beside the
 * page, which any component can fill with content and empty again.
 *
 * The shell owns the frame (the header with its label, the close button, the
 * scrolling body, Escape to close, and closing when the route changes) so a
 * component that peeks an issue only supplies what goes inside. Nothing in
 * this pull request fills it; the issue properties work does.
 *
 * ```tsx
 * const { openPeek, closePeek } = usePeek();
 * openPeek({ key: issue.key, label: issue.key, node: <IssuePeek ... /> });
 * ```
 *
 * `key` identifies what is showing, so opening the same key twice keeps the
 * pane as it is and a caller can tell whether its own content is the one open.
 * Outside a workspace the hook hands back a pane that is always empty and
 * whose functions do nothing, so a component renders the same in a test.
 */

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/** What fills the pane. */
export interface PeekContent {
  /** Identifies the content, such as an issue key. */
  key: string;
  /** The accessible name and the header text of the pane. */
  label: string;
  /** What the pane shows under its header. */
  node: ReactNode;
}

/** What {@link usePeek} hands back. */
export interface PeekState {
  /** The content showing, or null when the pane is closed. */
  content: PeekContent | null;
  /** Fills the pane, replacing whatever it held. */
  openPeek: (content: PeekContent) => void;
  /** Empties and hides the pane. */
  closePeek: () => void;
}

/** The pane the workspace layout provides, or null outside one. */
export const PeekContext = createContext<PeekState | null>(null);

/** A pane that never opens, for use outside a workspace. */
const CLOSED: PeekState = {
  content: null,
  openPeek: () => undefined,
  closePeek: () => undefined,
};

/** The workspace's peek pane. */
export const usePeek = (): PeekState => useContext(PeekContext) ?? CLOSED;

export default usePeek;
