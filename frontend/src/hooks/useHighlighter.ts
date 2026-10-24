/**
 * The shared syntax highlighter for a component that shows code. It is null
 * until the highlighter's chunk arrives, which the first caller starts, and
 * every caller re-renders with it once it has.
 */

import { useEffect, useState } from 'react';
import {
  loadedHighlighter,
  loadHighlighter,
  type Highlighter,
} from '../lib/highlight';

/** The highlighter once loaded, loading it on first use. */
export const useHighlighter = (): Highlighter | null => {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(
    loadedHighlighter
  );

  useEffect(() => {
    if (highlighter !== null) return undefined;
    let live = true;
    void loadHighlighter().then((loaded) => {
      if (live) setHighlighter(() => loaded);
    });
    return () => {
      live = false;
    };
  }, [highlighter]);

  return highlighter;
};
