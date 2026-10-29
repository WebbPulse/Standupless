/**
 * The frame every planning timeline draws its lanes in: the scrolling view
 * with the names pinned on the left, the date header pinned on top with its
 * Today chip, and the grid lines and today line behind the lanes. The
 * projects timeline and the initiatives timeline share it, so both scroll,
 * step, zoom and jump to today the same way, and each only draws its own rows.
 * Each opens, rezooms and jumps back with the today line centred in the lanes
 * in view, so how long current work has run and what comes next both show.
 * A timeline with no names, such as the cycles band, passes a name width of
 * zero and its lanes take the whole view.
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { LuChevronLeft, LuChevronRight, LuMinus, LuPlus } from 'react-icons/lu';
import Button, { IconButton } from '../ui/button';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import {
  TIMELINE_ZOOMS,
  TIMELINE_ZOOM_LABELS,
  stepZoom,
  type TimelineHeader,
  type TimelineRange,
  type TimelineZoom,
} from '../../lib/timeline';

/** The width of the pinned name column, in pixels. */
export const NAME_WIDTH = 280;

/** The width of the pinned name column on a phone, in pixels, so the lanes keep most of the screen. */
export const PHONE_NAME_WIDTH = 148;

/** The query the phone layout answers to, below Tailwind's `sm` breakpoint. */
export const WIDER_THAN_PHONE = '(min-width: 40rem)';

/** The pinned name column's width for the viewport: the full column, or the narrow one on a phone. */
export const useNameWidth = (): number =>
  useMediaQuery(WIDER_THAN_PHONE) ? NAME_WIDTH : PHONE_NAME_WIDTH;

/** How far from the left edge of the lanes a day sits when the view jumps to it. */
export const JUMP_INSET = 160;

/** The share of the view one step earlier or later moves it by. */
export const STEP_SHARE = 0.8;

/** The part of the timeline in view, in lane pixels. */
export interface ViewWindow {
  left: number;
  right: number;
}

/** What a page holding a timeline can ask of it. */
export interface TimelineHandle {
  /** Scrolls the view so the today line sits in the middle of the lanes in view. */
  scrollToToday: () => void;
  /** Moves the view most of a screen earlier, or later. */
  step: (direction: -1 | 1) => void;
}

/** What useTimelineView reads: the drawn range and scale, and the page's handle. */
export interface TimelineViewOptions {
  range: TimelineRange;
  pxPerDay: number;
  zoom: TimelineZoom;
  today: number;
  /** Whether any row is drawn, so the first placement waits for one. */
  hasRows: boolean;
  ref?: React.Ref<TimelineHandle> | undefined;
  /** The pinned name column's width, left out for the responsive column. */
  nameWidth?: number | undefined;
}

/** What useTimelineView answers: the scroller to attach and how to move it. */
export interface TimelineView {
  scroller: React.RefObject<HTMLDivElement | null>;
  view: ViewWindow;
  /** Reads the visible window again, for the scroller's scroll event. */
  readView: () => void;
  /** Scrolls so a day sits `inset` pixels from the left edge of the lanes. */
  scrollToDay: (day: number, inset?: number) => void;
}

/** The width of the lanes in view, past a pinned name column `nameWidth` wide. */
const lanesInView = (node: HTMLElement, nameWidth: number): number =>
  Math.max(0, node.clientWidth - nameWidth);

/**
 * Keeps a timeline's view: it opens with the today line centred, centres it
 * again when the zoom changes, holds the day at the centre when the data or
 * range changes so a refetch never moves a view the user scrolled, follows
 * resizes, and answers the page's Today and step requests through `ref`.
 */
export const useTimelineView = ({
  range,
  pxPerDay,
  zoom,
  today,
  hasRows,
  ref,
  nameWidth: fixedNameWidth,
}: TimelineViewOptions): TimelineView => {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewWindow>({ left: 0, right: 0 });
  const centre = useRef<number | null>(null);
  const responsiveNameWidth = useNameWidth();
  const nameWidth = fixedNameWidth ?? responsiveNameWidth;

  const readView = useCallback((): void => {
    const node = scroller.current;
    if (node === null) return;
    const left = node.scrollLeft;
    const right = left + lanesInView(node, nameWidth);
    centre.current = range.start + (left + (right - left) / 2) / pxPerDay;
    setView((held) =>
      held.left === left && held.right === right ? held : { left, right }
    );
  }, [range.start, pxPerDay, nameWidth]);

  const scrollToDay = useCallback(
    (day: number, inset = JUMP_INSET): void => {
      const node = scroller.current;
      if (node === null) return;
      node.scrollLeft = Math.max(0, (day - range.start) * pxPerDay - inset);
      readView();
    },
    [range.start, pxPerDay, readView]
  );

  const centreToday = useCallback((): void => {
    const node = scroller.current;
    if (node === null) return;
    scrollToDay(today + 0.5, lanesInView(node, nameWidth) / 2);
  }, [scrollToDay, today, nameWidth]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToToday: centreToday,
      step: (direction) => {
        const node = scroller.current;
        if (node === null) return;
        const width = lanesInView(node, nameWidth);
        node.scrollLeft = Math.max(
          0,
          node.scrollLeft + direction * Math.round(width * STEP_SHARE)
        );
        readView();
      },
    }),
    [centreToday, readView, nameWidth]
  );

  const placedZoom = useRef<TimelineZoom | null>(null);
  useLayoutEffect(() => {
    if (!hasRows) return;
    const node = scroller.current;
    if (node === null) return;
    if (placedZoom.current !== zoom) {
      placedZoom.current = zoom;
      centreToday();
      return;
    }
    if (centre.current !== null) {
      scrollToDay(centre.current, lanesInView(node, nameWidth) / 2);
    }
  }, [zoom, hasRows, centreToday, scrollToDay, nameWidth]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      readView();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [readView, hasRows]);

  return { scroller, view, readView, scrollToDay };
};

/** Props for the header and grid: the drawn range, its ticks and the scale. */
interface TimelineScaleProps {
  range: TimelineRange;
  header: TimelineHeader;
  pxPerDay: number;
  laneWidth: number;
  /** Where the today line runs, in lane pixels. */
  todayLeft: number;
  /** The pinned name column's width, left out for the responsive column. */
  nameWidth?: number | undefined;
}

/** Props for TimelineDateHeader: the scale and what the name column says. */
export interface TimelineDateHeaderProps extends TimelineScaleProps {
  /** What sits above the names, such as "4 projects". */
  countLabel: string;
}

/** The date header pinned above the lanes, with its Today chip. */
export const TimelineDateHeader: React.FC<TimelineDateHeaderProps> = ({
  range,
  header,
  pxPerDay,
  laneWidth,
  todayLeft,
  countLabel,
  nameWidth: fixedNameWidth,
}) => {
  const responsiveNameWidth = useNameWidth();
  const nameWidth = fixedNameWidth ?? responsiveNameWidth;
  return (
    <div className="sticky top-0 z-30 flex border-b border-line bg-bg">
      {nameWidth > 0 && (
        <div
          className="sticky left-0 z-10 flex shrink-0 items-end border-r border-line bg-bg px-4 pb-1.5 text-xs text-text-muted"
          style={{ width: nameWidth }}
        >
          {countLabel}
        </div>
      )}
      <div
        className="relative h-12 shrink-0"
        style={{ width: laneWidth }}
        aria-hidden="true"
      >
        {header.major.map((tick) => (
          <span
            key={`major-${String(tick.day)}`}
            className="absolute top-0 flex h-6 items-center border-l border-line px-2 text-xs font-medium text-text"
            style={{
              left: (tick.day - range.start) * pxPerDay,
              width: tick.span * pxPerDay,
            }}
          >
            <span className="sticky truncate" style={{ left: nameWidth + 8 }}>
              {tick.label}
            </span>
          </span>
        ))}
        {header.minor.map((tick) => (
          <span
            key={`minor-${String(tick.day)}`}
            className="absolute top-6 flex h-6 items-center overflow-hidden border-l border-line/60 pl-1 text-2xs text-text-faint"
            style={{
              left: (tick.day - range.start) * pxPerDay,
              width: tick.span * pxPerDay,
            }}
          >
            {tick.span * pxPerDay >= 18 ? tick.label : ''}
          </span>
        ))}
        <span
          className="absolute top-6 z-10 -translate-x-1/2 rounded-xs bg-accent px-1 text-2xs font-medium text-bg"
          style={{ left: todayLeft }}
        >
          Today
        </span>
      </div>
    </div>
  );
};

/** Props for TimelineGrid: the scale and anything drawn over the grid, such as link lines. */
export interface TimelineGridProps extends TimelineScaleProps {
  children?: React.ReactNode;
}

/** The grid lines and today line behind the lanes. */
export const TimelineGrid: React.FC<TimelineGridProps> = ({
  range,
  header,
  pxPerDay,
  laneWidth,
  todayLeft,
  children,
  nameWidth: fixedNameWidth,
}) => {
  const responsiveNameWidth = useNameWidth();
  const nameWidth = fixedNameWidth ?? responsiveNameWidth;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0"
      style={{ left: nameWidth, width: laneWidth }}
    >
      {header.major.map((tick) => (
        <span
          key={`grid-${String(tick.day)}`}
          className="absolute inset-y-0 border-l border-line"
          style={{ left: (tick.day - range.start) * pxPerDay }}
        />
      ))}
      <span
        data-testid="timeline-today"
        className="absolute inset-y-0 z-10 w-px bg-accent"
        style={{ left: todayLeft }}
      />
      {children}
    </div>
  );
};

/** Props for TimelineControls: the zoom and what its buttons do. */
export interface TimelineControlsProps {
  zoom: TimelineZoom;
  onZoomChange: (zoom: TimelineZoom) => void;
  onToday: () => void;
  /** Moves the view earlier or later, left out where the page offers no stepping. */
  onStep?: (direction: -1 | 1) => void;
}

/** The earlier, Today and later buttons and the zoom scale a timeline's toolbar carries. */
export const TimelineControls: React.FC<TimelineControlsProps> = ({
  zoom,
  onZoomChange,
  onToday,
  onStep,
}) => (
  <>
    {onStep !== undefined && (
      <IconButton
        label="Earlier"
        size="sm"
        onClick={() => {
          onStep(-1);
        }}
      >
        <LuChevronLeft className="h-3.5 w-3.5" />
      </IconButton>
    )}
    <Button variant="ghost" size="sm" onClick={onToday}>
      Today
    </Button>
    {onStep !== undefined && (
      <IconButton
        label="Later"
        size="sm"
        onClick={() => {
          onStep(1);
        }}
      >
        <LuChevronRight className="h-3.5 w-3.5" />
      </IconButton>
    )}
    <IconButton
      label="Zoom out"
      size="sm"
      disabled={zoom === 'year'}
      onClick={() => {
        onZoomChange(stepZoom(zoom, 1));
      }}
    >
      <LuMinus className="h-3.5 w-3.5" />
    </IconButton>
    <div
      role="radiogroup"
      aria-label="Zoom"
      className="flex items-center rounded-sm border border-line p-0.5 max-sm:hidden"
    >
      {TIMELINE_ZOOMS.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={zoom === value}
          onClick={() => {
            onZoomChange(value);
          }}
          className={cn(
            'h-6 rounded-xs px-2 text-xs transition-colors duration-100',
            zoom === value
              ? 'bg-raised text-text'
              : 'text-text-muted hover:text-text'
          )}
        >
          {TIMELINE_ZOOM_LABELS[value]}
        </button>
      ))}
    </div>
    <IconButton
      label="Zoom in"
      size="sm"
      disabled={zoom === 'week'}
      onClick={() => {
        onZoomChange(stepZoom(zoom, -1));
      }}
    >
      <LuPlus className="h-3.5 w-3.5" />
    </IconButton>
  </>
);
