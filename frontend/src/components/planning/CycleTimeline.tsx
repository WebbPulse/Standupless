/**
 * A team's cycles as bars along a time axis, the band that heads the cycles
 * page. Past cycles sit left of the today line and upcoming ones right of it,
 * the current cycle is drawn in the accent, and every bar names its cycle, its
 * dates and how much of its scope is done, with the done share filled in.
 * It draws in the shared planning timeline frame with no name column, so it
 * opens with the today line centred and scrolls, steps and zooms the way the
 * projects and initiatives timelines do.
 *
 * A bar opens its cycle on click or Enter. Left and Right move focus between
 * bars, Home and End jump to the first and last, and the cycle the page's
 * J and K highlight rests on is ringed here too and scrolled into view.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  TimelineDateHeader,
  TimelineGrid,
  useTimelineView,
  type TimelineHandle,
} from './TimelineFrame';
import { cn } from '../../lib/cn';
import { cycleTitle } from '../../lib/cycleBreakdown';
import {
  cycleBandDates,
  cycleBandLayout,
  neighbourIndex,
} from '../../lib/cycleTimeline';
import { completionPercent, shortCountsLabel } from '../../lib/planningDisplay';
import {
  PX_PER_DAY,
  offscreenSide,
  timelineHeader,
  timelineRange,
  todayNumber,
  type TimelineZoom,
} from '../../lib/timeline';
import type { CycleRead, CycleStatus } from '../../types/Api';

/** The height of one lane of bars, in pixels. */
const LANE_HEIGHT = 56;

/** The space above the first lane and below the last, in pixels. */
const LANE_PADDING = 8;

/** How far from the left edge of the band a bar sits when it is scrolled to. */
const REVEAL_INSET = 24;

/** The look each cycle status takes on the band. */
const STATUS_LOOKS: Record<CycleStatus, string> = {
  active: 'border-accent bg-accent-soft text-text',
  upcoming: 'border-dashed border-line bg-bg text-text hover:border-text-faint',
  completed: 'border-line bg-surface text-text-muted hover:border-text-faint',
  cancelled:
    'border-line bg-bg text-text-faint opacity-70 hover:border-text-faint',
};

/** What a screen reader hears after a cycle's name, by its status. */
const STATUS_WORDS: Record<CycleStatus, string> = {
  active: 'current',
  upcoming: 'upcoming',
  completed: 'completed',
  cancelled: 'cancelled',
};

/** Props for CycleTimeline: the cycles drawn and where each one opens. */
export interface CycleTimelineProps {
  cycles: readonly CycleRead[];
  hrefFor: (cycle: CycleRead) => string;
  zoom: TimelineZoom;
  /** The cycle the page's keyboard highlight rests on, ringed on the band. */
  highlightedId?: string | null;
  ref?: React.Ref<TimelineHandle>;
}

/** The scrolling band of cycle bars under a date header with a today line. */
export const CycleTimeline: React.FC<CycleTimelineProps> = ({
  cycles,
  hrefFor,
  zoom,
  highlightedId = null,
  ref,
}) => {
  const navigate = useNavigate();
  const pxPerDay = PX_PER_DAY[zoom];
  const [today] = useState(() => todayNumber());
  const layout = useMemo(() => cycleBandLayout(cycles), [cycles]);
  const range = useMemo(
    () =>
      timelineRange(
        cycles.flatMap((cycle) => [cycle.start_date, cycle.end_date]),
        today
      ),
    [cycles, today]
  );
  const header = useMemo(() => timelineHeader(range, zoom), [range, zoom]);
  const laneWidth = (range.end - range.start) * pxPerDay;
  const todayLeft = (today - range.start + 0.5) * pxPerDay;
  const { scroller, view, readView, scrollToDay } = useTimelineView({
    range,
    pxPerDay,
    zoom,
    today,
    hasRows: layout.bars.length > 0,
    ref,
    nameWidth: 0,
  });
  const bars = useRef(new Map<number, HTMLAnchorElement>());

  const highlighted = layout.bars.find(
    (placed) => placed.cycle.cycle_id === highlightedId
  );
  const highlightedStart = highlighted?.bar.start ?? null;
  const highlightedEnd = highlighted?.bar.end ?? null;
  const latestView = useRef(view);
  useEffect(() => {
    latestView.current = view;
  }, [view]);

  useEffect(() => {
    if (highlightedStart === null || highlightedEnd === null) return;
    const left = (highlightedStart - range.start) * pxPerDay;
    const width = (highlightedEnd - highlightedStart + 1) * pxPerDay;
    const { left: viewLeft, right: viewRight } = latestView.current;
    if (left >= viewLeft && left + width <= viewRight) return;
    scrollToDay(highlightedStart, REVEAL_INSET);
  }, [highlightedStart, highlightedEnd, range.start, pxPerDay, scrollToDay]);

  const onBarKey = (
    event: React.KeyboardEvent<HTMLAnchorElement>,
    index: number,
    href: string
  ): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void navigate(href);
      return;
    }
    const next = neighbourIndex(event.key, index, layout.bars.length);
    if (next === null) return;
    event.preventDefault();
    const target = layout.bars[next];
    if (target === undefined) return;
    const left = (target.bar.start - range.start) * pxPerDay;
    const width = (target.bar.end - target.bar.start + 1) * pxPerDay;
    if (offscreenSide(left, width, view.left, view.right) !== null) {
      scrollToDay(target.bar.start, REVEAL_INSET);
    }
    bars.current.get(next)?.focus();
  };

  return (
    <div
      ref={scroller}
      onScroll={readView}
      className="relative overflow-x-auto overflow-y-hidden rounded-md border border-line bg-bg"
      data-testid="cycle-timeline"
    >
      <div className="relative" style={{ width: laneWidth }}>
        <TimelineDateHeader
          range={range}
          header={header}
          pxPerDay={pxPerDay}
          laneWidth={laneWidth}
          todayLeft={todayLeft}
          countLabel=""
          nameWidth={0}
        />
        <div className="relative">
          <TimelineGrid
            range={range}
            header={header}
            pxPerDay={pxPerDay}
            laneWidth={laneWidth}
            todayLeft={todayLeft}
            nameWidth={0}
          />
          <ul
            aria-label="Cycles on the timeline"
            className="relative"
            style={{ height: layout.lanes * LANE_HEIGHT + LANE_PADDING * 2 }}
          >
            {layout.bars.map(({ cycle, bar, lane }, index) => {
              const href = hrefFor(cycle);
              const title = cycleTitle(cycle);
              const percent = completionPercent(cycle.counts);
              const dates = cycleBandDates(cycle);
              const scope = shortCountsLabel(cycle.counts);
              const summary =
                cycle.counts.total === 0
                  ? scope
                  : `${scope} done, ${String(percent)}%`;
              const left = (bar.start - range.start) * pxPerDay;
              const width = (bar.end - bar.start + 1) * pxPerDay;
              const isHighlighted = cycle.cycle_id === highlightedId;
              return (
                <li
                  key={cycle.cycle_id}
                  className="absolute"
                  style={{
                    left,
                    width,
                    top: LANE_PADDING + lane * LANE_HEIGHT,
                    height: LANE_HEIGHT - 8,
                  }}
                >
                  <Link
                    ref={(node) => {
                      if (node === null) bars.current.delete(index);
                      else bars.current.set(index, node);
                    }}
                    to={href}
                    aria-label={`${title}, ${STATUS_WORDS[cycle.status]}, ${dates}, ${summary}`}
                    title={`${title}\n${dates}\n${summary}`}
                    data-cycle-bar={cycle.cycle_id}
                    data-status={cycle.status}
                    data-highlighted={isHighlighted ? 'true' : undefined}
                    onKeyDown={(event) => {
                      onBarKey(event, index, href);
                    }}
                    className={cn(
                      'relative flex h-full flex-col justify-center overflow-hidden rounded-sm border px-2 text-xs transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                      STATUS_LOOKS[cycle.status],
                      isHighlighted && 'ring-2 ring-accent'
                    )}
                  >
                    {cycle.counts.total > 0 && (
                      <span
                        aria-hidden="true"
                        data-testid={`cycle-bar-fill-${cycle.cycle_id}`}
                        className={cn(
                          'pointer-events-none absolute inset-y-0 left-0',
                          cycle.status === 'active'
                            ? 'bg-accent/25'
                            : 'bg-accent/10'
                        )}
                        style={{ width: `${String(percent)}%` }}
                      />
                    )}
                    <span
                      aria-hidden="true"
                      className={cn(
                        'relative flex min-w-0 items-center gap-1.5 truncate font-medium',
                        cycle.status === 'cancelled' && 'line-through'
                      )}
                    >
                      <span className="truncate">{title}</span>
                      {cycle.status === 'active' && (
                        <span className="shrink-0 rounded-xs bg-accent px-1 text-2xs font-medium text-bg">
                          Current
                        </span>
                      )}
                    </span>
                    <span
                      aria-hidden="true"
                      className="relative truncate text-2xs text-text-muted tabular-nums"
                    >
                      {`${dates} · ${scope}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default CycleTimeline;
