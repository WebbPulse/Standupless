/**
 * The tooltip: that it opens after a hover rests, and that a press, a leave
 * or Escape closes it, so it never hangs over what a click opened.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
