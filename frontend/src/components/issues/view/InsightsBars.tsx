/**
 * The upright stacked chart of the view insights panel: one column per group,
 * split by the segment dimension, over a recessive grid with its scale on the
 * right. A column on a filterable dimension narrows the list when clicked.
 * Text names the columns only when asked to, since the table beside the chart
 * usually carries them.
 */

import React from 'react';
import {
  FILTER_FOR,
  barDetail,
  bucketColor,
  chartTicks,
  formatMeasure,
  segmentColumns,
} from '../../../lib/insights';
import type { FilterField } from '../../../lib/issueView';
import type { InsightGroup, InsightsRead } from '../../../types/Api';

/** Props for InsightsBars. */
export interface InsightsBarsProps {
  data: InsightsRead;
  /** Names each column under its dot, and shows the legend no table stands in for. */
  labelled?: boolean | undefined;
  /** Narrows the list to one column, for dimensions with a list filter. */
  onPick?: ((field: FilterField, value: string) => void) | undefined;
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? '0%' : `${(part / whole) * 100}%`;

/** One column's fills: a single mark, or its segments with a surface gap between. */
const Column: React.FC<{
  group: InsightGroup;
  index: number;
  top: number;
  colors: Map<string, string>;
}> = ({ group, index, top, colors }) => (
  <span
    className="flex w-full max-w-7 min-w-1.5 flex-col-reverse gap-0.5 overflow-hidden rounded-t-sm"
    style={{
      height: percent(group.value, top),
      minHeight: group.value > 0 ? 2 : 0,
    }}
  >
    {group.segments.length === 0 ? (
      <span
        className="min-h-0 flex-1"
        style={{ backgroundColor: bucketColor(group, index) }}
      />
    ) : (
      group.segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <span
            key={segment.key ?? ''}
            className="min-h-0"
            style={{
              flexGrow: segment.value,
              flexBasis: 0,
              backgroundColor: colors.get(segment.key ?? ''),
            }}
          />
        ))
    )}
  </span>
);

/** The chart, drawn in the order the groups arrive so it follows the table's sort. */
export const InsightsBars: React.FC<InsightsBarsProps> = ({
  data,
  labelled = false,
  onPick,
}) => {
  const columns = segmentColumns(data);
  const colors = new Map(columns.map((column) => [column.key, column.color]));
  const ticks = chartTicks(
    data.groups.reduce((most, group) => Math.max(most, group.value), 0)
  );
  const top = ticks[ticks.length - 1] ?? 1;
  const field = FILTER_FOR[data.group_by];
  const minWidth = data.groups.length * (labelled ? 56 : 24);

  return (
    <div className="flex flex-col gap-2">
      {labelled && columns.length > 0 && (
        <ul aria-label="Segments" className="flex flex-wrap gap-x-3 gap-y-1">
          {columns.map((column) => (
            <li
              key={column.key}
              className="flex items-center gap-1.5 text-xs text-text-muted"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: column.color }}
              />
              {column.bucket.label}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ minWidth }}>
            <div className="relative h-44">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  aria-hidden="true"
                  className="absolute inset-x-0 border-t border-line"
                  style={{ bottom: percent(tick, top) }}
                />
              ))}
              <ul
                aria-label="Breakdown"
                className="absolute inset-0 flex items-end gap-1"
              >
                {data.groups.map((group, index) => {
                  const detail = barDetail(group, data.measure);
                  const tip = [
                    group.label,
                    detail,
                    ...group.segments.map(
                      (segment) =>
                        `${segment.label}: ${formatMeasure(segment.value, data.measure)}`
                    ),
                  ].join('\n');
                  const column = (
                    <Column
                      group={group}
                      index={index}
                      top={top}
                      colors={colors}
                    />
                  );
                  return (
                    <li
                      key={group.key ?? ''}
                      className="flex h-full min-w-0 flex-1 justify-center"
                    >
                      {field !== undefined && onPick !== undefined ? (
                        <button
                          type="button"
                          title={tip}
                          aria-label={`${group.label}, ${detail}. Filter the list to it`}
                          className="flex h-full w-full items-end justify-center rounded-sm hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                          onClick={() => {
                            onPick(field, group.key ?? 'none');
                          }}
                        >
                          {column}
                        </button>
                      ) : (
                        <div
                          role="img"
                          title={tip}
                          aria-label={`${group.label}, ${detail}`}
                          className="flex h-full w-full items-end justify-center"
                        >
                          {column}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div aria-hidden="true" className="mt-1.5 flex gap-1">
              {data.groups.map((group, index) => (
                <span
                  key={group.key ?? ''}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: bucketColor(group, index) }}
                  />
                  {labelled && (
                    <span className="w-full truncate text-center text-xs text-text-muted">
                      {group.label}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div
          aria-hidden="true"
          className="relative h-44 w-7 shrink-0 text-xs text-text-faint tabular-nums"
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 leading-none"
              style={{ bottom: percent(tick, top) }}
            >
              {tick}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default InsightsBars;
