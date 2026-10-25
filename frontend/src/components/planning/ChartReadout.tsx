/**
 * The hover readout the planning charts share: a small card that hangs off a
 * vertical guide, a hook that tracks which slot of a chart the pointer or the
 * arrow keys are on, and the rows the card lists. The card flips to the far
 * side of the guide past the middle of the chart, so it always stays inside
 * the chart's bounds, and it is drawn from the theme tokens so it reads in
 * light and dark alike.
 */

import React, { useCallback, useState } from 'react';

const GAP = 8;

/** One labelled value in a readout, with the colour of its series. */
export interface ReadoutRow {
  label: string;
  value: string;
  /** A Tailwind class that draws the series swatch. */
  swatch: string;
}

/** Props for ChartReadout: where its guide is and what it says. */
export interface ChartReadoutProps {
  /** The guide's distance from the chart's left edge, in pixels. */
  anchor: number;
  /** The chart's width in pixels. */
  width: number;
  /** The distance from the chart's top edge, in pixels. */
  top: number;
  title: string;
  /** A short line under the title, such as the unit or that it is projected. */
  caption?: string;
  rows: ReadoutRow[];
  testId?: string;
}

/**
 * Where a readout sits beside a guide at `anchor` in a chart `width` wide:
 * to its right in the left half and to its left in the right half.
 */
export const readoutSide = (
  anchor: number,
  width: number
): { left: number } | { right: number } =>
  anchor <= width / 2
    ? { left: Math.max(0, anchor + GAP) }
    : { right: Math.max(0, width - anchor + GAP) };

/** Formats a chart value with at most one decimal place. */
export const formatValue = (value: number): string =>
  String(Math.round(value * 10) / 10);

/** The readout card beside a chart's guide. */
export const ChartReadout: React.FC<ChartReadoutProps> = ({
  anchor,
  width,
  top,
  title,
  caption,
  rows,
  testId,
}) => (
  <div
    aria-hidden="true"
    data-testid={testId}
    className="pointer-events-none absolute z-10 min-w-32 rounded-md border border-line bg-overlay px-2.5 py-2 text-xs text-text shadow-overlay"
    style={{ top, ...readoutSide(anchor, width) }}
  >
    <p className="font-medium">{title}</p>
    {caption !== undefined && <p className="text-text-faint">{caption}</p>}
    <dl className="mt-1.5 space-y-0.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-3">
          <dt className="inline-flex flex-1 items-center gap-1.5 text-text-muted">
            <span
              aria-hidden="true"
              className={`h-0.5 w-2.5 rounded-full ${row.swatch}`}
            />
            {row.label}
          </dt>
          <dd className="tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  </div>
);

/** What useChartCursor hands a chart to wire onto its focusable frame. */
export interface ChartCursor {
  /** The slot the pointer or keyboard is on, or `null` for none. */
  active: number | null;
  frameProps: {
    tabIndex: number;
    onMouseMove: (event: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
}

/**
 * Tracks the slot of a chart under the pointer or picked with the arrow
 * keys. `slotAt` maps a distance from the frame's left edge to a slot,
 * `count` is how many slots there are and `initial` is the slot focus lands
 * on first.
 */
export const useChartCursor = (
  count: number,
  slotAt: (offset: number) => number,
  initial: number
): ChartCursor => {
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const clamp = useCallback(
    (index: number): number => Math.min(Math.max(index, 0), count - 1),
    [count]
  );

  const onMouseMove = (event: React.MouseEvent<HTMLElement>): void => {
    if (count === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    setActive(clamp(slotAt(event.clientX - box.left)));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (count === 0) return;
    const current = active ?? clamp(initial);
    const next =
      event.key === 'ArrowLeft'
        ? current - 1
        : event.key === 'ArrowRight'
          ? current + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? count - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(clamp(next));
  };

  return {
    active: active === null || count === 0 ? null : clamp(active),
    frameProps: {
      tabIndex: 0,
      onMouseMove,
      onMouseLeave: () => {
        if (!focused) setActive(null);
      },
      onFocus: () => {
        setFocused(true);
        if (count > 0) setActive((current) => current ?? clamp(initial));
      },
      onBlur: () => {
        setFocused(false);
        setActive(null);
      },
      onKeyDown,
    },
  };
};

export default ChartReadout;
