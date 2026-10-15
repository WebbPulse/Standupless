/**
 * The tooltip: that it opens after a hover rests, and that a press, a leave
 * or Escape closes it, so it never hangs over what a click opened, and that a
 * closed bubble takes no layout, that the bubble renders on the document body
 * so no panel clips it, and that an open one stays inside the viewport.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeBeside, shiftIntoView } from '../../lib/viewport';
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

  it('renders the bubble on the document body, outside any clipping panel', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden', width: 40 }}>
        <Tooltip text="Oct 14, 2026, 11:04 AM">
          <time>3d ago</time>
        </Tooltip>
      </div>
    );

    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(bubble().parentElement).toBe(document.body);
    expect(bubble()).toHaveClass('fixed');
  });

  it('closes when the page scrolls', () => {
    renderTip();
    hover();

    fireEvent.scroll(window);

    expect(bubble()).not.toHaveAttribute('data-open');
  });
});

describe('placeBeside', () => {
  it('opens on the preferred side when it fits', () => {
    expect(placeBeside(100, 120, 20, 800, 'top')).toBe(74);
    expect(placeBeside(100, 120, 20, 800, 'bottom')).toBe(126);
  });

  it('flips below when there is no room above', () => {
    expect(placeBeside(10, 30, 20, 800, 'top')).toBe(36);
  });

  it('flips above when there is no room below', () => {
    expect(placeBeside(770, 790, 20, 800, 'bottom')).toBe(744);
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
