/**
 * Swipe and long press on one list row, for a finger on a touch screen, the
 * way Linear's mobile web works a list. A horizontal swipe slides the row
 * under the finger; released past the trigger distance it runs that side's
 * action, or, for a side that reveals, a short swipe holds the row open on
 * its action button and only a long swipe runs it. A press held still opens
 * the row's menu with a haptic tap.
 *
 * Only touch pointers take part, so a mouse press, a row drag and a right
 * click behave exactly as before. The row is meant to carry `touch-action:
 * pan-y`: a gesture that starts vertical stays the browser's scroll, which
 * cancels the press, so scrolling is never captured. The tap the browser
 * synthesises after a swipe or a long press is swallowed, so a swipe never
 * also opens the issue under it.
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { buzz } from '../lib/haptics';

/** The direction the finger moves: left slides the row left. */
export type SwipeSide = 'left' | 'right';

/** One side's action. */
export interface SwipeAction {
  /** Runs on a swipe released past the trigger or commit distance. */
  onCommit: () => void;
  /**
   * True for a side whose short swipe holds the row open on its button
   * rather than running the action, which then takes a long swipe or a tap
   * on that button.
   */
  reveals?: boolean | undefined;
}

/** Options for useSwipeActions. */
export interface SwipeOptions {
  /** Off for a fine pointer, where every handler stands down. */
  enabled: boolean;
  /** The action a swipe to the left runs. Absent, the row does not slide left. */
  left?: SwipeAction | undefined;
  /** The action a swipe to the right runs. Absent, the row does not slide right. */
  right?: SwipeAction | undefined;
  /** Opens the row's menu at the press, after a long press. */
  onLongPress?: ((x: number, y: number) => void) | undefined;
}

/** The handlers the sliding element spreads on. */
export interface SwipeHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onTouchEnd: (event: React.TouchEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
  onContextMenuCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

/** What useSwipeActions returns. */
export interface SwipeActions {
  /** How far the row is slid, in pixels, negative to the left. */
  offset: number;
  /** The side held open on its button, or null. */
  revealed: SwipeSide | null;
  /** True while a finger is sliding the row, when it should not animate. */
  dragging: boolean;
  handlers: SwipeHandlers;
  /** The slid row's transform, or undefined at rest. */
  style: React.CSSProperties | undefined;
  /** Slides the row back closed. */
  close: () => void;
  /** Slides the row closed and runs a side's action, for its revealed button. */
  commit: (side: SwipeSide) => void;
}

/** How far a finger moves before a press becomes a swipe or a scroll. */
export const SLOP_PX = 10;

/** How long a press is held still before it opens the menu. */
export const LONG_PRESS_MS = 500;

/** How far a swipe goes before it runs, or reveals, its action. */
export const TRIGGER_PX = 56;

/** How wide a revealed action button is, where the row rests while open. */
export const REVEAL_PX = 72;

/** The shortest long swipe that runs a revealing side's action. */
export const COMMIT_MIN_PX = 140;

/** The share of the row's width a long swipe crosses. */
export const COMMIT_RATIO = 0.5;

/** The row width assumed when the element reports none. */
const FALLBACK_WIDTH = 400;

/** How long the synthesised tap after a gesture is swallowed. */
const CLICK_GUARD_MS = 600;

/** How long after a long press opens the menu the browser's own menu is held off. */
const NATIVE_MENU_GUARD_MS = 1000;

/** What a released swipe does. */
export type SwipeOutcome = 'commit' | 'reveal' | 'close';

/** The distance a long swipe crosses on a row of this width. */
export const commitDistance = (width: number): number =>
  Math.max(COMMIT_MIN_PX, width * COMMIT_RATIO);

/** What a swipe released at `offset` does, for the action on its side. */
export const swipeOutcome = (
  offset: number,
  width: number,
  action: SwipeAction | undefined
): SwipeOutcome => {
  if (action === undefined) return 'close';
  const distance = Math.abs(offset);
  if (action.reveals !== true) {
    return distance >= TRIGGER_PX ? 'commit' : 'close';
  }
  if (distance >= commitDistance(width)) return 'commit';
  return distance >= TRIGGER_PX ? 'reveal' : 'close';
};

/** One finger's press on the row, from down to up. */
interface Press {
  id: number;
  x: number;
  y: number;
  mode: 'pending' | 'swipe' | 'scroll' | 'held';
  /** The offset the row rested at when the press began. */
  base: number;
  width: number;
  timer: number | null;
}

/** Stops a press's long press timer. */
const stopTimer = (press: Press): void => {
  if (press.timer !== null) {
    window.clearTimeout(press.timer);
    press.timer = null;
  }
};

/** Keeps the pointer's events on the row while it slides, where the browser allows. */
const capture = (element: HTMLElement, pointerId: number): void => {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    return;
  }
};

/** The offset a revealed side rests at. */
const restingOffset = (side: SwipeSide | null): number =>
  side === 'left' ? -REVEAL_PX : side === 'right' ? REVEAL_PX : 0;

/** Swipe and long press on one row, for touch pointers only. */
export const useSwipeActions = ({
  enabled,
  left,
  right,
  onLongPress,
}: SwipeOptions): SwipeActions => {
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState<SwipeSide | null>(null);
  const [dragging, setDragging] = useState(false);
  const press = useRef<Press | null>(null);
  const suppress = useRef(false);
  const heldAt = useRef(0);
  const guard = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (press.current !== null) stopTimer(press.current);
      if (guard.current !== null) window.clearTimeout(guard.current);
    },
    []
  );

  const swallowNextClick = (): void => {
    suppress.current = true;
    if (guard.current !== null) window.clearTimeout(guard.current);
    guard.current = window.setTimeout(() => {
      suppress.current = false;
      guard.current = null;
    }, CLICK_GUARD_MS);
  };

  const allowed = (next: number): number => {
    if (next < 0 && left === undefined) return 0;
    if (next > 0 && right === undefined) return 0;
    return next;
  };

  const slid = (entry: Press, clientX: number): number => {
    const travel = entry.width > 0 ? entry.width : FALLBACK_WIDTH;
    return Math.max(
      -travel,
      Math.min(travel, allowed(entry.base + clientX - entry.x))
    );
  };

  const close = (): void => {
    setRevealed(null);
    setOffset(0);
  };

  const commit = (side: SwipeSide): void => {
    close();
    (side === 'left' ? left : right)?.onCommit();
  };

  const handlers: SwipeHandlers = {
    onPointerDown: (event) => {
      suppress.current = false;
      if (!enabled || event.pointerType !== 'touch') return;
      if (press.current !== null) return;
      const { clientX: x, clientY: y, pointerId: id } = event;
      const entry: Press = {
        id,
        x,
        y,
        mode: 'pending',
        base: restingOffset(revealed),
        width: event.currentTarget.getBoundingClientRect().width,
        timer: null,
      };
      if (onLongPress !== undefined) {
        const open = onLongPress;
        entry.timer = window.setTimeout(() => {
          entry.timer = null;
          if (entry.mode !== 'pending') return;
          entry.mode = 'held';
          heldAt.current = Date.now();
          swallowNextClick();
          buzz();
          open(x, y);
        }, LONG_PRESS_MS);
      }
      press.current = entry;
    },
    onPointerMove: (event) => {
      const entry = press.current;
      if (entry === null || event.pointerId !== entry.id) return;
      if (entry.mode === 'pending') {
        const dx = event.clientX - entry.x;
        const dy = event.clientY - entry.y;
        if (Math.hypot(dx, dy) < SLOP_PX) return;
        stopTimer(entry);
        const slides =
          left !== undefined || right !== undefined || entry.base !== 0;
        if (Math.abs(dx) <= Math.abs(dy) || !slides) {
          entry.mode = 'scroll';
          return;
        }
        entry.mode = 'swipe';
        capture(event.currentTarget, event.pointerId);
        setDragging(true);
      }
      if (entry.mode !== 'swipe') return;
      setOffset(slid(entry, event.clientX));
    },
    onPointerUp: (event) => {
      const entry = press.current;
      if (entry === null || event.pointerId !== entry.id) return;
      press.current = null;
      stopTimer(entry);
      setDragging(false);
      if (entry.mode === 'held') {
        swallowNextClick();
        return;
      }
      if (entry.mode === 'swipe') {
        swallowNextClick();
        const next = slid(entry, event.clientX);
        const side: SwipeSide = next < 0 ? 'left' : 'right';
        const action = side === 'left' ? left : right;
        const outcome =
          next === 0 ? 'close' : swipeOutcome(next, entry.width, action);
        if (outcome === 'reveal') {
          setRevealed(side);
          setOffset(restingOffset(side));
          return;
        }
        close();
        if (outcome === 'commit' && action !== undefined) action.onCommit();
        return;
      }
      if (entry.mode === 'pending' && entry.base !== 0) {
        swallowNextClick();
        close();
      }
    },
    onPointerCancel: (event) => {
      const entry = press.current;
      if (entry === null || event.pointerId !== entry.id) return;
      press.current = null;
      stopTimer(entry);
      setDragging(false);
      if (entry.mode === 'swipe') setOffset(entry.base);
    },
    onTouchEnd: (event) => {
      if (suppress.current && event.cancelable) event.preventDefault();
    },
    onClickCapture: (event) => {
      if (!suppress.current) return;
      suppress.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenuCapture: (event) => {
      const entry = press.current;
      if (
        entry?.mode === 'held' ||
        (heldAt.current !== 0 &&
          Date.now() - heldAt.current < NATIVE_MENU_GUARD_MS)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (entry?.mode === 'pending') {
        stopTimer(entry);
        entry.mode = 'held';
        swallowNextClick();
        buzz();
      }
    },
  };

  const shown = enabled ? offset : 0;
  return {
    offset: shown,
    revealed: enabled ? revealed : null,
    dragging: enabled && dragging,
    handlers,
    style:
      shown === 0 ? undefined : { transform: `translateX(${String(shown)}px)` },
    close,
    commit,
  };
};

export default useSwipeActions;
