/**
 * The rendered width of an element, kept current as it resizes, so a chart
 * can draw in real pixels at a fixed height instead of scaling its text with
 * the page.
 */

import { useCallback, useLayoutEffect, useState } from 'react';

/**
 * A callback ref for the element and its width in pixels, or `fallback`
 * until it has been measured or where `ResizeObserver` is missing.
 */
export const useElementWidth = <T extends HTMLElement>(
  fallback: number
): [(node: T | null) => void, number] => {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState<number>(fallback);
  const ref = useCallback((next: T | null) => {
    setNode(next);
  }, []);

  useLayoutEffect(() => {
    if (node === null) return;
    const read = (): void => {
      const measured = Math.floor(node.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [node]);

  return [ref, width];
};

export default useElementWidth;
