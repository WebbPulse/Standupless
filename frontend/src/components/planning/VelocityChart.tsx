/**
 * A team's velocity: one column per closed cycle, the scope the cycle held on
 * its last day drawn faint behind what it completed, with the average as a
 * dashed rule across. Plain SVG drawn in real pixels at a fixed height across
 * the width of its container, so the text stays at the app's small size at
 * any window width, summed up in words for a reader who cannot see it.
 *
 * Hovering a column, or focusing the chart and stepping with the arrow keys,
 * highlights that cycle and shows a readout of what it completed against its
 * scope at close, announced through a live region.
 */

import React from 'react';
import { useElementWidth } from '../../hooks/useElementWidth';
import type { PlanningMeasure } from '../../lib/planningModel';
import type { VelocityCycleRead } from '../../types/Api';
import { axisTicks } from './BurnUpChart';
import { ChartReadout, formatValue, useChartCursor } from './ChartReadout';

/** Props for VelocityChart: the closed cycles oldest first and the measure. */
export interface VelocityChartProps {
  cycles: VelocityCycleRead[];
  measure: PlanningMeasure;
  average: number;
}

const WIDTH = 640;
const HEIGHT = 160;
const PAD_LEFT = 28;
const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;
const MAX_BAR = 48;
const FONT_SIZE = 11;
const CHAR_WIDTH = 6.5;

/** A cycle name cut to the characters that fit in a slot `slot` pixels wide. */
export const fitLabel = (name: string, slot: number): string => {
  const room = Math.max(3, Math.floor((slot - 4) / CHAR_WIDTH));
  return name.length > room ? `${name.slice(0, room - 1)}…` : name;
};

/** The completed and scope values of one cycle in the chosen measure. */
const valuesOf = (
  cycle: VelocityCycleRead,
  measure: PlanningMeasure
): { completed: number; scope: number } =>
  measure === 'points'
    ? { completed: cycle.completed_points, scope: cycle.scope_points }
    : { completed: cycle.completed_issues, scope: cycle.scope_issues };

/** The velocity bar chart. */
export const VelocityChart: React.FC<VelocityChartProps> = ({
  cycles,
  measure,
  average,
}) => {
  const [measureRef, width] = useElementWidth<HTMLDivElement>(WIDTH);
  const unit = measure === 'points' ? 'points' : 'issues';
  const rows = cycles.map((cycle) => ({
    cycle,
    ...valuesOf(cycle, measure),
  }));
  const highest = Math.max(
    average,
    ...rows.map((row) => Math.max(row.scope, row.completed))
  );
  const ticks = axisTicks(highest);
  const top = ticks[ticks.length - 1] ?? 1;
  const plotWidth = width - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const slot = plotWidth / Math.max(rows.length, 1);
  const bar = Math.min(MAX_BAR, slot * 0.6);
  const y = (value: number): number =>
    PAD_TOP + plotHeight - (value / top) * plotHeight;
  const summary =
    rows.length === 0
      ? 'No closed cycles yet.'
      : `Completed ${unit} per cycle: ${rows
          .map((row) => `${row.cycle.name} ${String(row.completed)}`)
          .join(', ')}. Average ${String(average)}.`;
  const cursor = useChartCursor(
    rows.length,
    (offset) => Math.floor((offset - PAD_LEFT) / slot),
    rows.length - 1
  );
  const activeRow = cursor.active === null ? undefined : rows[cursor.active];
  const activeCentre =
    cursor.active === null ? 0 : PAD_LEFT + slot * cursor.active + slot / 2;
  const activeText =
    activeRow === undefined
      ? ''
      : `${activeRow.cycle.name}: ${formatValue(activeRow.completed)} of ${formatValue(activeRow.scope)} ${unit} completed.`;

  return (
    <figure className="space-y-2">
      <div
        ref={measureRef}
        className="relative w-full rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
        role="group"
        aria-label="Velocity chart cycles. Use the left and right arrow keys to read each cycle."
        data-testid="velocity-frame"
        {...cursor.frameProps}
      >
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`}
          className="block max-w-full"
          data-testid="velocity-svg"
          role="img"
          aria-label={`Velocity chart. ${summary}`}
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
                data-testid="velocity-tick"
              >
                {String(tick)}
              </text>
            </g>
          ))}
          {rows.map((row, index) => {
            const centre = PAD_LEFT + slot * index + slot / 2;
            return (
              <g
                key={row.cycle.cycle_id}
                data-testid="velocity-bar"
                data-active={cursor.active === index ? 'true' : undefined}
              >
                {cursor.active === index && (
                  <rect
                    x={PAD_LEFT + slot * index}
                    y={PAD_TOP}
                    width={slot}
                    height={plotHeight}
                    fill="var(--line)"
                    opacity="0.5"
                    pointerEvents="none"
                  />
                )}
                <rect
                  x={centre - bar / 2}
                  y={y(row.scope)}
                  width={bar}
                  height={Math.max(0, y(0) - y(row.scope))}
                  rx="2"
                  fill="var(--raised)"
                  stroke="var(--line)"
                />
                <rect
                  x={centre - bar / 2}
                  y={y(row.completed)}
                  width={bar}
                  height={Math.max(0, y(0) - y(row.completed))}
                  rx="2"
                  fill="var(--accent)"
                />
                <text
                  x={centre}
                  y={Math.max(PAD_TOP + 8, y(row.completed) - 4)}
                  textAnchor="middle"
                  fontSize={FONT_SIZE}
                  fill="var(--text-muted)"
                >
                  {String(row.completed)}
                </text>
                <text
                  x={centre}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize={FONT_SIZE}
                  fill="var(--text-faint)"
                >
                  {fitLabel(row.cycle.name, slot)}
                </text>
              </g>
            );
          })}
          {rows.length > 0 && (
            <line
              x1={PAD_LEFT}
              x2={width - PAD_RIGHT}
              y1={y(average)}
              y2={y(average)}
              stroke="var(--warning)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
          )}
        </svg>
        {activeRow !== undefined && (
          <ChartReadout
            anchor={
              activeCentre + (bar / 2) * (activeCentre <= width / 2 ? 1 : -1)
            }
            width={width}
            top={PAD_TOP}
            title={activeRow.cycle.name}
            caption={`In ${unit}`}
            rows={[
              {
                label: 'Completed',
                value: formatValue(activeRow.completed),
                swatch: 'bg-accent',
              },
              {
                label: 'Scope at close',
                value: formatValue(activeRow.scope),
                swatch: 'bg-text-faint',
              },
            ]}
            testId="velocity-readout"
          />
        )}
        <p className="sr-only" aria-live="polite" data-testid="velocity-live">
          {activeText}
        </p>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-xs bg-accent" />
          Completed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-xs border border-line bg-raised"
          />
          Scope at close
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-0 w-3 border-t border-dashed border-warning"
          />
          Average
        </span>
      </figcaption>
    </figure>
  );
};

export default VelocityChart;
