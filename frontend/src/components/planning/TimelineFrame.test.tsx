/**
 * The shared timeline view. Covers that a timeline opens with the today line
 * centred in the lanes past the pinned name column, at desktop and phone
 * widths, that a zoom change centres it again, that the toolbar's Today
 * button brings it back after scrolling away, that a refetch leaves a
 * position the user scrolled to alone, and that a phone narrows the pinned
 * name column and drops the zoom presets.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PX_PER_DAY, type TimelineZoom } from '../../lib/timeline';
import { TimelineControls } from './ProjectTimeline';
import {
  NAME_WIDTH,
  PHONE_NAME_WIDTH,
  type TimelineHandle,
  useTimelineView,
} from './TimelineFrame';

const TODAY = 200;
const RANGE = { start: 0, end: 400 };

let viewportWidth = 880;
const offsets = new WeakMap<Element, number>();
const saved = {
  clientWidth: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientWidth'
  ),
  scrollWidth: Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollWidth'
  ),
  scrollLeft: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft'),
};

beforeEach(() => {
  viewportWidth = 880;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => viewportWidth,
  });
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get: () => 100_000,
  });
  Object.defineProperty(Element.prototype, 'scrollLeft', {
    configurable: true,
    get(this: Element) {
      return offsets.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      offsets.set(this, Math.max(0, value));
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, target] of [
    ['clientWidth', HTMLElement.prototype],
    ['scrollWidth', Element.prototype],
    ['scrollLeft', Element.prototype],
  ] as const) {
    const descriptor = saved[name];
    if (descriptor === undefined) {
      Reflect.deleteProperty(target, name);
    } else {
      Object.defineProperty(target, name, descriptor);
    }
  }
});

/** Props for Harness: the zoom and the range the timeline draws. */
interface HarnessProps {
  zoom: TimelineZoom;
  range?: { start: number; end: number };
  onZoomChange?: (zoom: TimelineZoom) => void;
}

/** A bare timeline scroller wired to the toolbar controls, as the pages wire it. */
const Harness: React.FC<HarnessProps> = ({
  zoom,
  range = RANGE,
  onZoomChange = () => undefined,
}) => {
  const handle = useRef<TimelineHandle | null>(null);
  const { scroller, readView } = useTimelineView({
    range,
    pxPerDay: PX_PER_DAY[zoom],
    zoom,
    today: TODAY,
    hasRows: true,
    ref: handle,
  });
  return (
    <>
      <TimelineControls
        zoom={zoom}
        onZoomChange={onZoomChange}
        onToday={() => {
          handle.current?.scrollToToday();
        }}
      />
      <div ref={scroller} onScroll={readView} data-testid="scroller" />
    </>
  );
};

/** Where the scroller sits when the today line is centred in the lanes in view. */
const centred = (
  zoom: TimelineZoom,
  width = viewportWidth,
  nameWidth = NAME_WIDTH
): number =>
  Math.max(
    0,
    (TODAY - RANGE.start + 0.5) * PX_PER_DAY[zoom] - (width - nameWidth) / 2
  );

/** Makes every media query miss, as a viewport below the `sm` breakpoint does. */
const stubPhone = (): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
};

const scroller = (): HTMLElement => screen.getByTestId('scroller');

describe('useTimelineView', () => {
  it('opens with the today line centred past the name column', () => {
    render(<Harness zoom="month" />);
    expect(scroller().scrollLeft).toBe(centred('month'));
    const todayInView =
      (TODAY + 0.5) * PX_PER_DAY.month - scroller().scrollLeft;
    expect(todayInView).toBe((880 - NAME_WIDTH) / 2);
  });

  it('centres the today line at a phone width too', () => {
    viewportWidth = 360;
    render(<Harness zoom="month" />);
    expect(scroller().scrollLeft).toBe(centred('month', 360));
  });

  it('centres the today line again when the zoom changes', () => {
    const { rerender } = render(<Harness zoom="month" />);
    act(() => {
      scroller().scrollLeft = 40;
      fireEvent.scroll(scroller());
    });
    rerender(<Harness zoom="week" />);
    expect(scroller().scrollLeft).toBe(centred('week'));
  });

  it('brings the today line back to the centre from the Today button', async () => {
    render(<Harness zoom="quarter" />);
    act(() => {
      scroller().scrollLeft = 12;
      fireEvent.scroll(scroller());
    });
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(scroller().scrollLeft).toBe(centred('quarter'));
  });

  it('keeps a position the user scrolled to when the data refetches', () => {
    const { rerender } = render(<Harness zoom="month" />);
    act(() => {
      scroller().scrollLeft = 640;
      fireEvent.scroll(scroller());
    });
    rerender(<Harness zoom="month" range={{ ...RANGE }} />);
    expect(scroller().scrollLeft).toBe(640);
    rerender(
      <Harness zoom="month" range={{ start: RANGE.start - 30, end: 400 }} />
    );
    expect(scroller().scrollLeft).toBe(640 + 30 * PX_PER_DAY.month);
  });

  it('centres past the narrow phone name column below the sm breakpoint', () => {
    stubPhone();
    viewportWidth = 390;
    render(<Harness zoom="month" />);
    expect(scroller().scrollLeft).toBe(centred('month', 390, PHONE_NAME_WIDTH));
  });

  it('hides the zoom presets on a phone and keeps the zoom steps', () => {
    render(<Harness zoom="month" />);
    expect(screen.getByRole('radiogroup', { name: 'Zoom' })).toHaveClass(
      'max-sm:hidden'
    );
    expect(screen.getByRole('button', { name: 'Zoom in' })).not.toHaveClass(
      'max-sm:hidden'
    );
  });
});
