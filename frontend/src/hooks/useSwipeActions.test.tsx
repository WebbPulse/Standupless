/**
 * Row swipes and long presses: what a released swipe does at each distance,
 * that a short swipe on a revealing side holds the row open and a long one
 * runs the action, that a vertical drag and a mouse press do nothing, that a
 * long press opens the menu once and swallows the tap after it, and that a
 * disabled row ignores every gesture.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { START, swipe, touchPointer } from '../test/touch';
import {
  COMMIT_MIN_PX,
  LONG_PRESS_MS,
  REVEAL_PX,
  TRIGGER_PX,
  swipeOutcome,
  useSwipeActions,
  type SwipeOptions,
} from './useSwipeActions';

vi.mock('../lib/haptics', () => ({ buzz: vi.fn() }));

/** A row wired to the hook, which reports its offset and its clicks. */
const Row: React.FC<SwipeOptions & { onClick?: () => void }> = ({
  onClick,
  ...options
}) => {
  const actions = useSwipeActions(options);
  return (
    <div
      data-testid="row"
      data-offset={actions.offset}
      data-revealed={actions.revealed ?? ''}
      style={actions.style}
      onClick={onClick}
      {...actions.handlers}
    >
      Row
    </div>
  );
};

/** The rendered row. */
const row = (): HTMLElement => screen.getByTestId('row');

describe('swipeOutcome', () => {
  it('closes without an action on that side', () => {
    expect(swipeOutcome(-300, 400, undefined)).toBe('close');
  });

  it('commits a plain side past the trigger distance', () => {
    const action = { onCommit: vi.fn() };
    expect(swipeOutcome(TRIGGER_PX - 1, 400, action)).toBe('close');
    expect(swipeOutcome(TRIGGER_PX, 400, action)).toBe('commit');
  });

  it('reveals a revealing side on a short swipe and commits on a long one', () => {
    const action = { onCommit: vi.fn(), reveals: true };
    expect(swipeOutcome(-TRIGGER_PX, 400, action)).toBe('reveal');
    expect(swipeOutcome(-199, 400, action)).toBe('reveal');
    expect(swipeOutcome(-200, 400, action)).toBe('commit');
    expect(swipeOutcome(COMMIT_MIN_PX, 100, action)).toBe('commit');
  });
});

describe('useSwipeActions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the right action on a swipe right past the trigger', () => {
    const right = vi.fn();
    render(<Row enabled right={{ onCommit: right }} />);

    swipe(row(), TRIGGER_PX + 10);

    expect(right).toHaveBeenCalledTimes(1);
    expect(row()).toHaveAttribute('data-offset', '0');
  });

  it('springs back on a short swipe', () => {
    const right = vi.fn();
    render(<Row enabled right={{ onCommit: right }} />);

    swipe(row(), TRIGGER_PX - 20);

    expect(right).not.toHaveBeenCalled();
    expect(row()).toHaveAttribute('data-offset', '0');
  });

  it('holds a revealing side open on a short swipe and runs it on a long one', () => {
    const left = vi.fn();
    render(<Row enabled left={{ onCommit: left, reveals: true }} />);

    swipe(row(), -(TRIGGER_PX + 10));

    expect(left).not.toHaveBeenCalled();
    expect(row()).toHaveAttribute('data-revealed', 'left');
    expect(row()).toHaveAttribute('data-offset', String(-REVEAL_PX));

    swipe(row(), -300);

    expect(left).toHaveBeenCalledTimes(1);
    expect(row()).toHaveAttribute('data-offset', '0');
  });

  it('closes a revealed row on a tap without clicking through', () => {
    const onClick = vi.fn();
    render(
      <Row
        enabled
        left={{ onCommit: vi.fn(), reveals: true }}
        onClick={onClick}
      />
    );
    swipe(row(), -(TRIGGER_PX + 10));
    fireEvent.click(row());
    onClick.mockClear();

    touchPointer(row(), 'pointerdown', START.x, START.y);
    touchPointer(row(), 'pointerup', START.x, START.y);
    fireEvent.click(row());

    expect(row()).toHaveAttribute('data-offset', '0');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('swallows the tap the browser sends after a swipe', () => {
    const onClick = vi.fn();
    render(<Row enabled right={{ onCommit: vi.fn() }} onClick={onClick} />);

    swipe(row(), TRIGGER_PX + 10);
    fireEvent.click(row());

    expect(onClick).not.toHaveBeenCalled();
  });

  it('leaves a vertical drag to the scroll', () => {
    const right = vi.fn();
    render(<Row enabled right={{ onCommit: right }} />);

    swipe(row(), 30, 200);

    expect(right).not.toHaveBeenCalled();
    expect(row()).toHaveAttribute('data-offset', '0');
  });

  it('ignores a mouse', () => {
    const right = vi.fn();
    const onClick = vi.fn();
    render(<Row enabled right={{ onCommit: right }} onClick={onClick} />);

    swipe(row(), 200, 0, 'mouse');
    fireEvent.click(row());

    expect(right).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ignores every gesture while disabled', () => {
    const right = vi.fn();
    const onLongPress = vi.fn();
    render(
      <Row
        enabled={false}
        right={{ onCommit: right }}
        onLongPress={onLongPress}
      />
    );

    swipe(row(), 200);
    touchPointer(row(), 'pointerdown', START.x, START.y);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);

    expect(right).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('opens the menu on a long press and swallows the tap after it', () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    render(<Row enabled onLongPress={onLongPress} onClick={onClick} />);

    touchPointer(row(), 'pointerdown', START.x, START.y);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    touchPointer(row(), 'pointerup', START.x, START.y);
    fireEvent.click(row());

    expect(onLongPress).toHaveBeenCalledWith(START.x, START.y);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('holds the browser menu off after a long press opened its own', () => {
    const onLongPress = vi.fn();
    render(<Row enabled onLongPress={onLongPress} />);

    touchPointer(row(), 'pointerdown', START.x, START.y);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    const allowed = fireEvent.contextMenu(row());

    expect(allowed).toBe(false);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('cancels a long press once the finger moves', () => {
    const onLongPress = vi.fn();
    render(<Row enabled onLongPress={onLongPress} />);

    touchPointer(row(), 'pointerdown', START.x, START.y);
    touchPointer(row(), 'pointermove', START.x, START.y + 40);
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);

    expect(onLongPress).not.toHaveBeenCalled();
  });
});
