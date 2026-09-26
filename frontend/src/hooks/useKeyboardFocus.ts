/**
 * Tells focus that arrived from the keyboard apart from focus that arrived
 * from a click. Text fields and editable regions match `:focus-visible` on
 * every focus, so a surface meant to look exactly like the text it edits
 * would show a ring on each click; this lets it show one only when someone
 * tabbed there and needs to see where they are.
 */

import { useCallback, useRef, useState } from 'react';
import type React from 'react';

/** The handlers to spread on the focus region and whether to draw a ring. */
export interface KeyboardFocus {
  keyboardFocused: boolean;
  focusProps: {
    onPointerDownCapture: () => void;
    onFocus: () => void;
    onBlur: (event: React.FocusEvent) => void;
  };
}

/** Tracks whether the region holds focus that came from the keyboard. */
export const useKeyboardFocus = (): KeyboardFocus => {
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const pointer = useRef(false);

  const onPointerDownCapture = useCallback((): void => {
    pointer.current = true;
    setKeyboardFocused(false);
  }, []);

  const onFocus = useCallback((): void => {
    setKeyboardFocused(!pointer.current);
    pointer.current = false;
  }, []);

  const onBlur = useCallback((event: React.FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next !== null && event.currentTarget.contains(next)) return;
    pointer.current = false;
    setKeyboardFocused(false);
  }, []);

  return {
    keyboardFocused,
    focusProps: { onPointerDownCapture, onFocus, onBlur },
  };
};

export default useKeyboardFocus;
