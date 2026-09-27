/**
 * The tooltip: that it opens after a hover rests, and that a press, a leave
 * or Escape closes it, so it never hangs over what a click opened, and that a
 * closed bubble takes no layout and an open one stays inside the viewport.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shiftIntoView } from '../../lib/viewport';
import { Tooltip, TOOLTIP_DELAY_MS } from './tooltip';

const renderTip = () =>
  render(
    <Tooltip text="Create issue">
      <button type="button" aria-label="Create issue">
        +
      </button>
    </Tooltip>
  );

const bubble = () => screen.getByRole('tooltip', { hidden: true });

const hover = () => {
  const wrapper = screen.getByRole('button').parentElement;
  if (wrapper === null) throw new Error('no wrapper');
  fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  });
  return wrapper;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('opens once a hover rests', () => {
    renderTip();
    expect(bubble()).not.toHaveAttribute('data-open');

    hover();

    expect(bubble()).toHaveAttribute('data-open');
  });

  it('closes on a press and stays shut while the pointer stays', () => {
    renderTip();
    const wrapper = hover();

    fireEvent.pointerDown(screen.getByRole('button'));
    fireEvent.focus(screen.getByRole('button'));
    fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });

    expect(bubble()).not.toHaveAttribute('data-open');
  });

  it('closes when the pointer leaves or Escape is pressed', () => {
    renderTip();
    const wrapper = hover();

    fireEvent.pointerLeave(wrapper);
    expect(bubble()).not.toHaveAttribute('data-open');

    hover();
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' });
    expect(bubble()).not.toHaveAttribute('data-open');
  });

  it('takes no layout while closed', () => {
    renderTip();
    expect(bubble()).toHaveClass('not-data-open:hidden');
    expect(bubble()).not.toHaveAttribute('data-open');

    hover();

    expect(bubble()).toHaveAttribute('data-open');
  });
});

describe('shiftIntoView', () => {
  it('leaves a bubble that fits where it is', () => {
    expect(shiftIntoView(100, 200, 1000)).toBe(0);
  });

  it('pulls a bubble past the right edge back inside', () => {
    expect(shiftIntoView(950, 1030, 1000)).toBe(-38);
  });

  it('pushes a bubble past the left edge back inside', () => {
    expect(shiftIntoView(-20, 60, 1000)).toBe(28);
  });

  it('keeps the left edge in view when the bubble is wider than the window', () => {
    expect(shiftIntoView(0, 400, 300)).toBe(8);
  });
});
