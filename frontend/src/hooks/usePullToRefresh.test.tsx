/**
 * Pull to refresh: a pull from the top past the threshold refreshes once and
 * shows the spinner for a moment, a short pull or a cancelled one does not,
 * a pull that starts scrolled down or that goes up or sideways first is left
 * to the browser, and a disabled list never refreshes.
 */

import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PullIndicator from '../components/ui/PullIndicator';
import {
  PULL_THRESHOLD_PX,
  REFRESH_SHOW_MS,
  usePullToRefresh,
} from './usePullToRefresh';

vi.mock('../lib/haptics', () => ({ buzz: vi.fn() }));

/** A list wired to the hook. */
const List: React.FC<{ enabled: boolean; onRefresh: () => void }> = ({
  enabled,
  onRefresh,
}) => {
  const pull = usePullToRefresh(enabled, onRefresh);
  return (
    <div data-testid="list" ref={pull.ref}>
      <PullIndicator pull={pull.pull} refreshing={pull.refreshing} />
      <p>Rows</p>
    </div>
  );
};

/** Fires one touch event with a single finger at a point, or none for an end. */
const touch = (
  target: Element,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  x = 0,
  y = 0
): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches =
    type === 'touchend' || type === 'touchcancel'
      ? []
      : [{ clientX: x, clientY: y }];
  Object.defineProperty(event, 'touches', { value: touches });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

/** Pulls the list down by `dy` pixels of finger travel and lets go. */
const pull = (
  target: Element,
  dy: number,
  dx = 0,
  end: 'touchend' | 'touchcancel' = 'touchend'
): void => {
  touch(target, 'touchstart', 100, 50);
  touch(target, 'touchmove', 100 + dx / 2, 50 + dy / 2);
  touch(target, 'touchmove', 100 + dx, 50 + dy);
  touch(target, end);
};

/** The list element. */
const list = (): HTMLElement => screen.getByTestId('list');

describe('usePullToRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes once on a pull past the threshold and shows the spinner', () => {
    const onRefresh = vi.fn();
    render(<List enabled onRefresh={onRefresh} />);

    pull(list(), PULL_THRESHOLD_PX * 3);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing');
    act(() => {
      vi.advanceTimersByTime(REFRESH_SHOW_MS + 10);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('follows the finger and says when a release would refresh', () => {
    render(<List enabled onRefresh={vi.fn()} />);

    touch(list(), 'touchstart', 100, 50);
    const move = touch(list(), 'touchmove', 100, 50 + PULL_THRESHOLD_PX * 3);

    expect(move.defaultPrevented).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Release to refresh');
  });

  it('does not refresh on a short pull', () => {
    const onRefresh = vi.fn();
    render(<List enabled onRefresh={onRefresh} />);

    pull(list(), PULL_THRESHOLD_PX);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not refresh on a cancelled pull', () => {
    const onRefresh = vi.fn();
    render(<List enabled onRefresh={onRefresh} />);

    pull(list(), PULL_THRESHOLD_PX * 3, 0, 'touchcancel');

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('leaves a list scrolled down to the browser', () => {
    const onRefresh = vi.fn();
    render(<List enabled onRefresh={onRefresh} />);
    Object.defineProperty(list(), 'scrollTop', {
      configurable: true,
      value: 120,
    });

    pull(list(), PULL_THRESHOLD_PX * 3);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('leaves an upward or sideways drag to the browser', () => {
    const onRefresh = vi.fn();
    render(<List enabled onRefresh={onRefresh} />);

    pull(list(), -PULL_THRESHOLD_PX * 3);
    pull(list(), 20, 300);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('never refreshes while disabled', () => {
    const onRefresh = vi.fn();
    render(<List enabled={false} onRefresh={onRefresh} />);

    pull(list(), PULL_THRESHOLD_PX * 3);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
