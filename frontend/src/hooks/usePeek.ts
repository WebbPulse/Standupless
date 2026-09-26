/**
 * The right-side peek pane: an outlet the workspace shell renders beside the
 * page, which any component can fill with content and empty again.
 *
 * By default the shell owns the frame (the header with its label, the close
 * button, the scrolling body, Escape to close, and closing when the route
 * changes) so a component that peeks something only supplies what goes
 * inside. Content that brings its own header and close button, as the issue
 * peek does, sets `framed: false` and the shell draws it bare, so the pane
 * never shows two headers. {@link usePeekIssue} is the usual way in for an
 * issue.
 *
 * ```tsx
 * const { openPeek, closePeek } = usePeek();
 * openPeek({ key: 'help', label: 'Help', node: <HelpPanel /> });
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
  /**
   * False when the node draws its own header and close button, so the shell
   * renders it without its frame. Defaults to true.
   */
  framed?: boolean;
}

/** What {@link usePeek} hands back. */
export interface PeekState {
  /** The content showing, or null when the pane is closed. */
  content: PeekContent | null;
  /** Fills the pane, replacing whatever it held. */
  openPeek: (content: PeekContent) => void;
  /** Empties and hides the pane. The same function on every render. */
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
