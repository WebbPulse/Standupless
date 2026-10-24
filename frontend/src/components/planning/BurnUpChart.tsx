/**
 * A cycle's burn-up: scope, started and completed drawn as steps over the
 * cycle's days, with a dashed line for the pace that finishes the scope on
 * the last day and, once there is enough history, a dotted projection of
 * where completed work lands if the pace so far holds. Drawn as plain SVG in
 * real pixels at a fixed height across the width of its container, so the
 * text stays at the app's small size, and summed up in words for a reader who
 * cannot see it. While its data is still loading it shows a placeholder, never
 * the empty message.
 *
 * The y axis is labelled in whole numbers, each once, and a cycle whose scope
 * has been empty on every day so far says so instead of drawing an axis
 * stretched over nothing.
 *
 * A project's graph turns the target pace off and instead passes a forecast,
 * a dashed line from today to a named day, and its target date, drawn as a
 * marker on the day it falls.
 */

import React from 'react';
import { useElementWidth } from '../../hooks/useElementWidth';
import type { BurnUpPoint, ProjectForecast } from '../../lib/planningModel';

/** Props for BurnUpChart: the series so far and every day of the cycle. */
export interface BurnUpChartProps {
  points: BurnUpPoint[];
  /** Every day of the cycle, so days still to come keep their place. */
  days: string[];
  /** Completed work projected onto the last day, or `null` for none. */
  projection?: number | null;
  /** What the values count, for the summary a screen reader hears. */
  unit?: string;
  /** What shows in place of the chart while the scope has been empty every day. */
  emptyMessage?: string;
  /** Whether the series is still loading, so a placeholder shows instead. */
  isLoading?: boolean;
  /** Completed work projected onto a named day of `days`, drawn dashed from today. */
  forecast?: ProjectForecast | null;
  /** A day of `days` to mark as the target date. */
  targetDate?: string | null;
  /** Whether to draw the pace that finishes the scope on the last day. */
  showPace?: boolean;
}

const WIDTH = 640;
const HEIGHT = 160;
const PAD_LEFT = 28;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const FONT_SIZE = 11;
const LABEL_SLOT = 48;

/**
 * The y axis ticks for a chart topping out at `top`: zero, the top and a
 * whole-number midpoint between them when there is room for one, so no
 * label repeats.
 */
export const axisTicks = (top: number): number[] => {
  const ceiling = Math.max(1, Math.ceil(top));
  const middle = Math.round(ceiling / 2);
  return middle > 0 && middle < ceiling ? [0, middle, ceiling] : [0, ceiling];
};

/** A stepped path through the values, one step per day. */
const stepPath = (
  values: number[],
  x: (index: number) => number,
  y: (value: number) => number
): string =>
  values
    .map((value, index) => {
      const left = x(index);
      const right = x(index + 1);
      return `${index === 0 ? 'M' : 'L'}${String(left)} ${String(y(value))} L${String(right)} ${String(y(value))}`;
    })
    .join(' ');

/** How a `YYYY-MM-DD` day reads on the axis. */
const axisLabel = (value: string): string => {
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

/** The burn-up chart for one cycle. */
export const BurnUpChart: React.FC<BurnUpChartProps> = ({
  points,
  days,
  projection = null,
  unit = 'issues',
  emptyMessage = 'Nothing is in scope yet, so there is nothing to chart.',
  isLoading = false,
  forecast = null,
  targetDate = null,
  showPace = true,
}) => {
  const [measureRef, width] = useElementWidth<HTMLDivElement>(WIDTH);
  const count = Math.max(days.length, 1);
  const ticks = axisTicks(Math.max(0, ...points.map((point) => point.scope)));
  const top = ticks[ticks.length - 1] ?? 1;
  const plotWidth = width - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const x = (index: number): number => PAD_LEFT + (index / count) * plotWidth;
  const y = (value: number): number =>
    PAD_TOP + plotHeight - (value / top) * plotHeight;
  const last = points[points.length - 1];
  const scope = points.map((point) => point.scope);
  const started = points.map((point) => point.started);
  const completed = points.map((point) => point.completed);
  const labelCount = Math.max(1, Math.floor(plotWidth / LABEL_SLOT));
  const labelEvery = Math.max(1, Math.ceil(count / labelCount));
  const summary =
    last === undefined
      ? 'The cycle has not started yet.'
      : `Scope ${String(last.scope)}, started ${String(last.started)}, completed ${String(last.completed)} ${unit} as of ${last.date}.${projection === null ? '' : ` Projected to complete ${String(projection)} by the last day.`}`;
  const showProjection = projection !== null && last !== undefined;
  const forecastIndex = forecast === null ? -1 : days.indexOf(forecast.date);
  const showForecast =
    forecast !== null && last !== undefined && forecastIndex >= 0;
  const targetIndex = targetDate === null ? -1 : days.indexOf(targetDate);
  const fullSummary = showForecast
    ? `${summary} Projected to complete ${String(forecast.value)} by ${forecast.date}.`
    : summary;

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading burn-up chart"
        className="animate-pulse rounded-md bg-surface"
        style={{ height: HEIGHT }}
        data-testid="burn-up-loading"
      />
    );
  }

  if (points.length > 0 && points.every((point) => point.scope === 0)) {
    return (
      <p className="text-sm text-text-muted" data-testid="burn-up-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <figure className="space-y-2">
      <div ref={measureRef} className="w-full">
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`}
          className="block max-w-full"
          role="img"
          aria-label={`Burn-up chart. ${fullSummary}`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD_LEFT}
                x2={width - PAD_RIGHT}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--line)"
                strokeWidth="1"
              />
              <text
                x={PAD_LEFT - 6}
                y={y(tick) + 3}
                textAnchor="end"
                fontSize={FONT_SIZE}
                fill="var(--text-faint)"
                data-testid="burn-up-tick"
              >
                {String(tick)}
              </text>
            </g>
          ))}
          {days.map((day, index) =>
            index % labelEvery === 0 ? (
              <text
                key={day}
                x={x(index) + plotWidth / count / 2}
                y={HEIGHT - 6}
                textAnchor="middle"
                fontSize={FONT_SIZE}
                fill="var(--text-faint)"
              >
                {axisLabel(day)}
              </text>
            ) : null
          )}
          {showPace && last !== undefined && (
            <line
              x1={x(0)}
              y1={y(0)}
              x2={x(count)}
              y2={y(last.scope)}
              stroke="var(--text-faint)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
          )}
          {points.length > 0 && (
            <>
              <path
                d={stepPath(scope, x, y)}
                fill="none"
                stroke="var(--text-muted)"
                strokeWidth="1.5"
              />
              <path
                d={stepPath(started, x, y)}
                fill="none"
                stroke="var(--warning)"
                strokeWidth="1.5"
              />
              <path
                d={`${stepPath(completed, x, y)} L${String(x(points.length))} ${String(y(0))} L${String(x(0))} ${String(y(0))} Z`}
                fill="var(--accent-soft)"
                stroke="none"
              />
              <path
                d={stepPath(completed, x, y)}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
              />
              {showProjection && (
                <line
                  x1={x(points.length)}
                  y1={y(last.completed)}
                  x2={x(count)}
                  y2={y(projection)}
                  stroke="var(--accent)"
                  strokeWidth="1.5"
                  strokeDasharray="2 3"
                  data-testid="burn-up-projection"
                />
              )}
              {showForecast && (
                <line
                  x1={x(points.length)}
                  y1={y(last.completed)}
                  x2={x(forecastIndex + 1)}
                  y2={y(forecast.value)}
                  stroke="var(--accent)"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  data-testid="burn-up-forecast"
                />
              )}
              <line
                x1={x(points.length)}
                x2={x(points.length)}
                y1={PAD_TOP}
                y2={PAD_TOP + plotHeight}
                stroke="var(--accent)"
                strokeWidth="1"
                opacity="0.5"
              />
            </>
          )}
          {targetIndex >= 0 && (
            <g data-testid="burn-up-target">
              <line
                x1={x(targetIndex + 1)}
                x2={x(targetIndex + 1)}
                y1={PAD_TOP}
                y2={PAD_TOP + plotHeight}
                stroke="var(--text-muted)"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <text
                x={x(targetIndex + 1) - 3}
                y={PAD_TOP + FONT_SIZE - 2}
                textAnchor="end"
                fontSize={FONT_SIZE}
                fill="var(--text-muted)"
              >
                Target
              </text>
            </g>
          )}
        </svg>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-0.5 w-3 rounded-full bg-text-muted"
          />
          Scope
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-0.5 w-3 rounded-full bg-warning"
          />
          Started
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-0.5 w-3 rounded-full bg-accent"
          />
          Completed
        </span>
        {showPace && (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-0 w-3 border-t border-dashed border-text-faint"
            />
            Target pace
          </span>
        )}
        {showForecast && (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-0 w-3 border-t border-dashed border-accent"
            />
            Projected
          </span>
        )}
        {targetIndex >= 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-3 w-0 border-l border-dashed border-text-muted"
            />
            Target date
          </span>
        )}
        {showProjection && (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-0 w-3 border-t border-dotted border-accent"
            />
            Projected
          </span>
        )}
      </figcaption>
    </figure>
  );
};

export default BurnUpChart;
