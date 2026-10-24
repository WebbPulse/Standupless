/**
 * Names the page for its desktop app tab. Only the desktop app with tabs reads
 * the document title as a tab label, so in a browser, or on a desktop build
 * without tabs, the document title is left exactly as it was.
 */

import { useEffect } from 'react';
import { desktopHasTabs } from '../lib/desktop';

/** Sets the document title to `label` while the page shows, in a desktop tab. */
export const useDesktopTabTitle = (label: string | null | undefined): void => {
  useEffect(() => {
    if (label === null || label === undefined || label.trim() === '') return;
    if (!desktopHasTabs()) return;
    const previous = document.title;
    document.title = label;
    return () => {
      document.title = previous;
    };
  }, [label]);
};
