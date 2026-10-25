/**
 * Keeps one team preset's display options across visits. Opening a preset
 * whose URL sets no display option of its own lays in the display the viewer
 * last left it in, and every later change to the URL is remembered for the
 * next visit, so each preset reopens the way it was left.
 */

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  readScopeDisplay,
  withScopeDisplay,
  writeScopeDisplay,
} from '../lib/teamIssueScope';

/**
 * Restores and remembers the display under `storageKey`. Without a key, as
 * while the page is still loading, nothing is read or written.
 */
export const useScopeDisplayMemory = (storageKey: string | undefined): void => {
  const [params, setParams] = useSearchParams();
  const restoredFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (storageKey === undefined) return;
    if (restoredFor.current !== storageKey) {
      restoredFor.current = storageKey;
      const next = withScopeDisplay(params, readScopeDisplay(storageKey));
      if (next !== null) {
        setParams(next, { replace: true });
        return;
      }
    }
    writeScopeDisplay(storageKey, params);
  }, [storageKey, params, setParams]);
};

export default useScopeDisplayMemory;
