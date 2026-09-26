/**
 * A cycle's burn-up: scope, started and completed drawn as steps over the
 * cycle's days, with a dashed line for the pace that finishes the scope on
 * the last day. Drawn as plain SVG in a fixed coordinate space that scales to
 * its container, and summed up in words for a reader who cannot see it.
 */

import React from 'react';
import type { BurnUpPoint } from '../../lib/planningModel';

/** Props for BurnUpChart: the series so far and every day of the cycle. */
export interface BurnUpChartProps {
  points: BurnUpPoint[];
  /** Every day of the cycle, so days still to come keep their place. */
  days: string[];
}

const WIDTH = 640;
const HEIGHT = 200;
const PAD_LEFT = 28;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;

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
export const BurnUpChart: React.FC<BurnUpChartProps> = ({ points, days }) => {
  const count = Math.max(days.length, 1);
  const top = Math.max(1, ...points.map((point) => point.scope));
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const x = (index: number): number => PAD_LEFT + (index / count) * plotWidth;
  const y = (value: number): number =>
    PAD_TOP + plotHeight - (value / top) * plotHeight;
  const last = points[points.length - 1];
  const scope = points.map((point) => point.scope);
  const started = points.map((point) => point.started);
  const completed = points.map((point) => point.completed);
  const labelEvery = Math.max(1, Math.ceil(count / 7));
  const summary =
    last === undefined
      ? 'The cycle has not started yet.'
      : `Scope ${String(last.scope)}, started ${String(last.started)}, completed ${String(last.completed)} as of ${last.date}.`;

  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Burn-up chart. ${summary}`}
      >
        {[0, 0.5, 1].map((share) => (
          <g key={share}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={y(top * share)}
              y2={y(top * share)}
              stroke="var(--line)"
              strokeWidth="1"
            />
            <text
              x={PAD_LEFT - 6}
              y={y(top * share) + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-faint)"
            >
              {String(Math.round(top * share))}
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
              fontSize="10"
              fill="var(--text-faint)"
            >
              {axisLabel(day)}
            </text>
          ) : null
        )}
        {last !== undefined && (
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
      </svg>
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
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-0 w-3 border-t border-dashed border-text-faint"
          />
          Target pace
        </span>
      </figcaption>
    </figure>
  );
};

export default BurnUpChart;
