/**
 * Pull to refresh on a scrolling list, for a finger on a touch screen. A
 * downward drag that starts while the list sits at its top pulls an
 * indicator down with some resistance; let go past the threshold and the
 * list refetches. A drag that starts anywhere else, or that goes up or
 * sideways first, is left to the browser, so ordinary scrolling and row
 * swipes are never captured.
 *
 * It listens to touch events rather than pointer events because a vertical
 * pan belongs to the browser, which cancels the pointer as soon as it starts
 * scrolling; touch events keep coming, and the pull holds the overscroll off
 * only while it is pulling.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { buzz } from '../lib/haptics';

/** How far the finger moves before a press reads as a pull or a scroll. */
const SLOP_PX = 8;

/** The share of the finger's travel the indicator follows. */
const RESISTANCE = 0.5;

/** The pull, in pixels of indicator travel, that refreshes on release. */
export const PULL_THRESHOLD_PX = 64;

/** The furthest the indicator travels. */
export const PULL_MAX_PX = 96;

/** How long the indicator spins after a refresh starts. */
export const REFRESH_SHOW_MS = 700;

/** What usePullToRefresh returns. */
export interface PullToRefresh {
  /** The callback ref for the scrolling element. */
  ref: (node: HTMLElement | null) => void;
  /** How far the indicator is pulled, in pixels. */
  pull: number;
  /** True while a refresh the pull started is showing. */
  refreshing: boolean;
}

/** The finger's press while it might become a pull. */
interface Pull {
  x: number;
  y: number;
  pulling: boolean;
}

/** Pull to refresh on the element the ref lands on, while `enabled`. */
export const usePullToRefresh = (
  enabled: boolean,
  onRefresh: () => void
): PullToRefresh => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useRef(onRefresh);
  const distance = useRef(0);

  useEffect(() => {
    refresh.current = onRefresh;
  }, [onRefresh]);

  const ref = useCallback((next: HTMLElement | null) => {
    setNode(next);
  }, []);

  useEffect(() => {
    if (!enabled || node === null) return undefined;
    let press: Pull | null = null;
    let timer: number | null = null;

    const show = (value: number): void => {
      distance.current = value;
      setPull(value);
    };

    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      press =
        event.touches.length === 1 && touch !== undefined && node.scrollTop <= 0
          ? { x: touch.clientX, y: touch.clientY, pulling: false }
          : null;
    };

    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (press === null || touch === undefined) return;
      const dx = touch.clientX - press.x;
      const dy = touch.clientY - press.y;
      if (!press.pulling) {
        if (Math.hypot(dx, dy) < SLOP_PX) return;
        if (dy <= 0 || Math.abs(dx) >= Math.abs(dy) || node.scrollTop > 0) {
          press = null;
          return;
        }
        press.pulling = true;
      }
      if (event.cancelable) event.preventDefault();
      show(Math.min(PULL_MAX_PX, Math.max(0, dy * RESISTANCE)));
    };

    const onEnd = (): void => {
      const pulled = press?.pulling === true;
      press = null;
      if (!pulled) return;
      const far = distance.current >= PULL_THRESHOLD_PX;
      show(0);
      if (!far) return;
      buzz();
      setRefreshing(true);
      refresh.current();
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        setRefreshing(false);
      }, REFRESH_SHOW_MS);
    };

    const onCancel = (): void => {
      press = null;
      show(0);
    };

    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd);
    node.addEventListener('touchcancel', onCancel);
    return () => {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('touchcancel', onCancel);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, node]);

  return { ref, pull: enabled ? pull : 0, refreshing: enabled && refreshing };
};

export default usePullToRefresh;
