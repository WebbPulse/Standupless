/**
 * A team's velocity: one column per closed cycle, the scope the cycle held on
 * its last day drawn faint behind what it completed, with the average as a
 * dashed rule across. Plain SVG in a fixed coordinate space that scales to
 * its container, summed up in words for a reader who cannot see it.
 */

import React from 'react';
import type { PlanningMeasure } from '../../lib/planningModel';
import type { VelocityCycleRead } from '../../types/Api';

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
  const unit = measure === 'points' ? 'points' : 'issues';
  const rows = cycles.map((cycle) => ({
    cycle,
    ...valuesOf(cycle, measure),
  }));
  const top = Math.max(
    1,
    average,
    ...rows.map((row) => Math.max(row.scope, row.completed))
  );
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
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

  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Velocity chart. ${summary}`}
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
        {rows.map((row, index) => {
          const centre = PAD_LEFT + slot * index + slot / 2;
          return (
            <g key={row.cycle.cycle_id} data-testid="velocity-bar">
              <title>{`${row.cycle.name}: ${String(row.completed)} of ${String(row.scope)} ${unit} completed`}</title>
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
                fontSize="10"
                fill="var(--text-muted)"
              >
                {String(row.completed)}
              </text>
              <text
                x={centre}
                y={HEIGHT - 6}
                textAnchor="middle"
                fontSize="10"
                fill="var(--text-faint)"
              >
                {row.cycle.name.length > 14
                  ? `${row.cycle.name.slice(0, 13)}…`
                  : row.cycle.name}
              </text>
            </g>
          );
        })}
        {rows.length > 0 && (
          <line
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={y(average)}
            y2={y(average)}
            stroke="var(--warning)"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        )}
      </svg>
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
