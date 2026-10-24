/**
 * Revealing truncated text: that overflow is detected across and down, that
 * the bubble opens only while the element is actually cut off and the
 * pointer rests on its own box, that keyboard focus reveals it at once, and
 * that a press or a leave closes it.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLTIP_DELAY_MS } from './tooltip';
import {
  TruncatedText,
  isTruncated,
  pointWithin,
  useTruncationTooltip,
} from './truncated-text';

interface Box {
  scrollWidth?: number;
  clientWidth?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

const sized = (element: HTMLElement, box: Box): HTMLElement => {
  const full = {
    scrollWidth: 100,
    clientWidth: 100,
    scrollHeight: 20,
    clientHeight: 20,
    ...box,
  };
  for (const [key, value] of Object.entries(full)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
  element.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
  return element;
};

const bubble = () => screen.queryByRole('tooltip', { hidden: true });

const rest = (element: HTMLElement, x = 10, y = 10) => {
  fireEvent.mouseMove(element, { clientX: x, clientY: y });
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isTruncated', () => {
  it('is false when the content fits', () => {
    expect(isTruncated(sized(document.createElement('span'), {}))).toBe(false);
  });

  it('is true when the content overflows across', () => {
    const element = sized(document.createElement('span'), {
      scrollWidth: 140,
    });
    expect(isTruncated(element)).toBe(true);
  });

  it('is true when a line clamp cuts the content off below', () => {
    const element = sized(document.createElement('span'), {
      scrollHeight: 60,
      clientHeight: 40,
    });
    expect(isTruncated(element)).toBe(true);
  });

  it('ignores a rounding pixel of height', () => {
    const element = sized(document.createElement('span'), {
      scrollHeight: 21,
    });
    expect(isTruncated(element)).toBe(false);
  });
});

describe('pointWithin', () => {
  const rect = new DOMRect(10, 10, 100, 20);

  it('holds for a point inside the rect', () => {
    expect(pointWithin(rect, 50, 20)).toBe(true);
  });

  it('fails for a point outside the rect', () => {
    expect(pointWithin(rect, 200, 20)).toBe(false);
    expect(pointWithin(rect, 50, 40)).toBe(false);
  });
});

describe('TruncatedText', () => {
  it('reveals the full text when it is cut off', () => {
    render(<TruncatedText>A very long issue title</TruncatedText>);
    const label = sized(screen.getByText('A very long issue title'), {
      scrollWidth: 240,
    });

    rest(label);

    expect(bubble()).toHaveAttribute('data-open');
    expect(bubble()).toHaveTextContent('A very long issue title');
  });

  it('stays shut when the text fits', () => {
    render(<TruncatedText>Short</TruncatedText>);
    const label = sized(screen.getByText('Short'), {});

    rest(label);

    expect(bubble()).toBeNull();
  });

  it('stays shut while the pointer is outside the element', () => {
    render(<TruncatedText>A very long issue title</TruncatedText>);
    const label = sized(screen.getByText('A very long issue title'), {
      scrollWidth: 240,
    });

    rest(label, 400, 10);

    expect(bubble()).toBeNull();
  });

  it('closes on leave and stays shut after a press', () => {
    render(<TruncatedText>A very long issue title</TruncatedText>);
    const label = sized(screen.getByText('A very long issue title'), {
      scrollWidth: 240,
    });

    rest(label);
    fireEvent.mouseLeave(label);
    expect(bubble()).toBeNull();

    fireEvent.pointerDown(label);
    rest(label);
    expect(bubble()).toBeNull();
  });

  it('shows the given text over the rendered children', () => {
    render(
      <TruncatedText text="Full name">
        <em>Full</em>
      </TruncatedText>
    );
    const label = sized(screen.getByText('Full').parentElement as HTMLElement, {
      scrollWidth: 240,
    });

    rest(label);

    expect(bubble()).toHaveTextContent('Full name');
  });
});

const Probe: React.FC<{ title: string }> = ({ title }) => {
  const { ref, handlers, tip } = useTruncationTooltip<HTMLAnchorElement>();
  return (
    <>
      <a ref={ref} href="#issue" {...handlers}>
        {title}
      </a>
      {tip}
    </>
  );
};

describe('useTruncationTooltip', () => {
  it('reveals a cut off link on keyboard focus', () => {
    render(<Probe title="A link that runs past its column" />);
    const link = sized(screen.getByRole('link'), { scrollWidth: 240 });
    const focusVisible = (selector: string): boolean =>
      selector === ':focus-visible';
    link.matches = focusVisible as typeof link.matches;

    fireEvent.focus(link);

    expect(bubble()).toHaveAttribute('data-open');
    expect(bubble()).toHaveTextContent('A link that runs past its column');

    fireEvent.keyDown(link, { key: 'Escape' });
    expect(bubble()).toBeNull();
  });
});
