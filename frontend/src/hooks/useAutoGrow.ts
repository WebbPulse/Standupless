/**
 * Sizes a textarea to fit what is written in it, so a draft grows with its
 * content and the page scrolls rather than a small box. With a cap, the box
 * stops growing there and only then scrolls inside itself.
 */

import { useCallback, useLayoutEffect, type RefObject } from 'react';

/** Sets the height of one textarea to its content, up to an optional cap. */
export const fitToContent = (
  element: HTMLTextAreaElement,
  maxHeight?: number
): void => {
  element.style.height = 'auto';
  const content = element.scrollHeight;
  const capped = maxHeight !== undefined && content > maxHeight;
  element.style.height = `${String(capped ? maxHeight : content)}px`;
  element.style.overflowY = capped ? 'auto' : 'hidden';
};

/**
 * Keeps a textarea sized to its content after every render, so it fits as soon
 * as it mounts and as each change lands, and refits when the window resizes.
 */
export const useAutoGrow = (
  ref: RefObject<HTMLTextAreaElement | null>,
  maxHeight?: number
): void => {
  const fit = useCallback((): void => {
    if (ref.current !== null) fitToContent(ref.current, maxHeight);
  }, [ref, maxHeight]);

  useLayoutEffect(() => {
    fit();
  });

  useLayoutEffect(() => {
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
    };
  }, [fit]);
};

export default useAutoGrow;
