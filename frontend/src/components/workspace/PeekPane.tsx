/**
 * The provider behind {@link usePeek} and the frame the shell renders it in.
 *
 * The pane remembers the path it was opened on and reads as closed once the
 * route moves, so following a link out of a peek never leaves a stale pane
 * beside the next page, and nothing has to write state back on navigation.
 */

import React, { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { LuX } from 'react-icons/lu';
import { useLocation } from 'react-router-dom';
import { PeekContext, usePeek } from '../../hooks/usePeek';
import type { PeekContent, PeekState } from '../../hooks/usePeek';
import { useShortcut } from '../../hooks/useShortcuts';
import { IconButton } from '../ui/button';

/** Props for PeekProvider: the subtree that may open the pane. */
export interface PeekProviderProps {
  children: ReactNode;
}

/** Holds what the pane shows and the path it was opened on. */
export const PeekProvider: React.FC<PeekProviderProps> = ({ children }) => {
  const location = useLocation();
  const [held, setHeld] = useState<{
    content: PeekContent;
    path: string;
  } | null>(null);

  const openPeek = useCallback(
    (content: PeekContent) => {
      setHeld({ content, path: location.pathname });
    },
    [location.pathname]
  );

  const closePeek = useCallback(() => {
    setHeld(null);
  }, []);

  const content =
    held !== null && held.path === location.pathname ? held.content : null;

  const value = useMemo<PeekState>(
    () => ({ content, openPeek, closePeek }),
    [content, openPeek, closePeek]
  );

  useShortcut({
    keys: 'escape',
    label: 'Close the peek',
    handler: closePeek,
    enabled: content !== null,
  });

  return <PeekContext.Provider value={value}>{children}</PeekContext.Provider>;
};

/**
 * The pane itself: nothing while closed, a labelled complementary region with
 * a close button and a scrolling body while open. Unframed content brings its
 * own region and header, so it is drawn bare in the same slot.
 */
export const PeekPane: React.FC = () => {
  const { content, closePeek } = usePeek();
  if (content === null) return null;
  if (content.framed === false) {
    return (
      <div
        data-testid="peek-pane"
        className="hidden max-w-[45vw] min-h-0 shrink-0 md:flex"
      >
        {content.node}
      </div>
    );
  }
  return (
    <aside
      aria-label={content.label}
      data-testid="peek-pane"
      className="hidden w-peek max-w-[45vw] shrink-0 flex-col border-l border-line bg-bg md:flex"
    >
      <div className="flex h-topbar shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {content.label}
        </span>
        <IconButton label="Close peek" size="sm" onClick={closePeek}>
          <LuX className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{content.node}</div>
    </aside>
  );
};

export default PeekPane;
