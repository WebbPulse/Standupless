/**
 * The jump a settings search match makes once the page is showing: scroll to
 * the section the hash names and highlight it for a moment, so the eye lands
 * on the control that was asked for.
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** How long a section stays highlighted after a jump, in milliseconds. */
export const HIGHLIGHT_MS = 1600;

/** How long a jump waits for a section that is still loading, in milliseconds. */
const WAIT_MS = 3000;

/** How often a jump looks again for a section that is still loading. */
const RETRY_MS = 100;

/** The attribute a highlighted section carries while it flashes. */
export const HIGHLIGHT_ATTRIBUTE = 'data-settings-highlight';

/** The hash decoded, or as written when it is not valid percent encoding. */
const safeDecode = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * Scrolls to the element the location's hash names and highlights it for a
 * moment. A section that loads after the page waits a few seconds to appear.
 * It reruns on every navigation, so choosing the section already in the hash
 * highlights it again.
 */
export const useSettingsHighlight = (): void => {
  const { hash, key } = useLocation();

  useEffect(() => {
    const id = safeDecode(hash.slice(1));
    if (id === '') return undefined;
    const started = Date.now();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let clear: ReturnType<typeof setTimeout> | undefined;
    let target: HTMLElement | null = null;

    const attempt = (): void => {
      target = globalThis.document.getElementById(id);
      if (target === null) {
        if (Date.now() - started < WAIT_MS)
          retry = setTimeout(attempt, RETRY_MS);
        return;
      }
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      target.setAttribute(HIGHLIGHT_ATTRIBUTE, '');
      const shown = target;
      clear = setTimeout(() => {
        shown.removeAttribute(HIGHLIGHT_ATTRIBUTE);
      }, HIGHLIGHT_MS);
    };
    attempt();

    return () => {
      clearTimeout(retry);
      clearTimeout(clear);
      target?.removeAttribute(HIGHLIGHT_ATTRIBUTE);
    };
  }, [hash, key]);
};
