/**
 * Keyboard movement through a flat list, so a list can be worked without the
 * mouse the way an issue tracker is worked in practice.
 *
 * The hook owns the DOM concern as well as the index. A caller hands each row
 * to `registerItem` and the hook scrolls the highlighted one into view itself,
 * because every list that adopts this would otherwise write the same effect and
 * the same ref map again.
 *
 * The listener sits on the document rather than on a focused element so the
 * keys work as soon as the list is on screen, which means it has to stand down
 * whenever someone is writing text or holding a modifier: Ctrl/Cmd+K belongs to
 * the command palette, not to a list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isModalOpen, isTypingTarget } from './useCommandPalette';

/** Options for {@link useListKeyboardNav}. */
export interface ListKeyboardNavOptions {
  /** How many rows the list is showing. Zero switches the keys off. */
  count: number;
  /** Opens the row at this index, run on Enter. */
  onActivate: (index: number) => void;
  /**
   * Shows the row at this index beside the list, run on Space. Leaving it out
   * leaves Space to the page, so it still scrolls a list with no peek.
   */
  onPeek?: (index: number) => void;
  /**
   * Changes with the list's contents, so the highlight drops rather than
   * pointing at whatever now sits at that position. Filters, or the ids, are
   * the usual thing to pass.
   */
  resetKey?: string;
  /** False while another surface owns the keyboard, such as an open dialog. */
  enabled?: boolean;
}

/** What {@link useListKeyboardNav} hands back to the list. */
export interface ListKeyboardNavResult {
  /** The highlighted row, or -1 when nothing is highlighted. */
  activeIndex: number;
  /** Moves the highlight, for a row that takes the pointer. */
  setActiveIndex: (index: number) => void;
  /**
   * Hands a row's element to the hook so the highlighted one can be scrolled
   * into view. Pass it straight to a row's `ref`. Scrolling is skipped where
   * the element cannot do it, such as jsdom, so a list still moves under test.
   */
  registerItem: (index: number) => (node: HTMLElement | null) => void;
}

/** Nothing highlighted. */
const NONE = -1;

/** Whether a key event should move a list rather than reach the page. */
const isPlainKey = (event: KeyboardEvent): boolean =>
  !event.ctrlKey && !event.metaKey && !event.altKey;

/** How far a key moves the highlight, or zero when it is not a movement key. */
const stepFor = (key: string): number => {
  if (key === 'j' || key === 'ArrowDown') return 1;
  if (key === 'k' || key === 'ArrowUp') return -1;
  return 0;
};

/**
 * Highlights a row and moves the highlight with j/k and the arrow keys, opens
 * it with Enter, peeks it with Space when the list can peek, and clears it
 * with Escape.
 *
 * The highlight clamps at both ends rather than wrapping, so holding a key does
 * not loop a long list back past where it started. It is derived against
 * `resetKey` rather than cleared in an effect, so a list whose contents change
 * shows no highlight in the same render the new rows arrive.
 */
export const useListKeyboardNav = ({
  count,
  onActivate,
  onPeek,
  resetKey = '',
  enabled = true,
}: ListKeyboardNavOptions): ListKeyboardNavResult => {
  const [state, setState] = useState({ index: NONE, key: resetKey });
  const items = useRef(new Map<number, HTMLElement>());

  const held = state.key === resetKey ? state.index : NONE;
  const activeIndex = held < count ? held : NONE;

  const setActiveIndex = useCallback(
    (index: number) => {
      setState({ index, key: resetKey });
    },
    [resetKey]
  );

  const registerItem = useCallback(
    (index: number) => (node: HTMLElement | null) => {
      if (node === null) items.current.delete(index);
      else items.current.set(index, node);
    },
    []
  );

  const latest = useRef({ activeIndex, onActivate, onPeek });
  latest.current = { activeIndex, onActivate, onPeek };

  useEffect(() => {
    if (!enabled || count === 0) return;

    const onKey = (event: KeyboardEvent) => {
      if (!isPlainKey(event) || isTypingTarget(event.target) || isModalOpen()) {
        return;
      }

      const current = latest.current.activeIndex;
      const step = stepFor(event.key);

      if (step !== 0) {
        event.preventDefault();
        const next =
          current === NONE ? (step === 1 ? 0 : count - 1) : current + step;
        setState({
          index: next < 0 ? 0 : next > count - 1 ? count - 1 : next,
          key: resetKey,
        });
        return;
      }

      if (event.key === 'Escape') {
        setState({ index: NONE, key: resetKey });
        return;
      }

      if (event.key === 'Enter' && current !== NONE) {
        event.preventDefault();
        latest.current.onActivate(current);
        return;
      }

      const peek = latest.current.onPeek;
      if (event.key === ' ' && current !== NONE && peek !== undefined) {
        event.preventDefault();
        peek(current);
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [enabled, count, resetKey]);

  useEffect(() => {
    if (activeIndex === NONE) return;
    const node = items.current.get(activeIndex);
    if (typeof node?.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  return { activeIndex, setActiveIndex, registerItem };
};

export default useListKeyboardNav;
