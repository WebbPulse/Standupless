/**
 * Open and close state for the command palette, and the global Ctrl/Cmd+K
 * shortcut that opens it.
 *
 * The listener lives in a hook rather than in the palette so the shell can own
 * the state and the palette can stay a controlled component. A shortcut that
 * fired while someone was writing an issue title would eat the keystroke, so
 * the handler stands down whenever the event came from a text entry, unless the
 * palette is already open and the entry is its own input.
 */

import { useCallback, useEffect, useState } from 'react';

/** What {@link useCommandPalette} hands back to the shell. */
export interface CommandPaletteState {
  /** Whether the palette is showing. */
  open: boolean;
  /** Opens the palette, for a button or a menu item that also offers it. */
  openPalette: () => void;
  /** Closes the palette. Pass this straight to the palette's `onClose`. */
  closePalette: () => void;
}

/**
 * Whether a key event came from somewhere a person is writing text, where a
 * bare shortcut would steal the keystroke.
 */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
};

/** Whether a keyboard event is the palette's open shortcut, Ctrl+K or Cmd+K. */
export const isPaletteShortcut = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  event.key.toLowerCase() === 'k';

/**
 * Holds whether the command palette is open and binds Ctrl/Cmd+K to opening
 * it.
 */
export const useCommandPalette = (): CommandPaletteState => {
  const [open, setOpen] = useState(false);

  const openPalette = useCallback(() => {
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      if (!open && isTypingTarget(event.target)) return;
      event.preventDefault();
      setOpen((wasOpen) => !wasOpen);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return { open, openPalette, closePalette };
};

export default useCommandPalette;
