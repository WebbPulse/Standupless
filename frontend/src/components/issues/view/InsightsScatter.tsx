/**
 * The scatterplot a time measure draws: one dot per issue in its bucket's
 * column at its duration, with a strip of percentile markers above. Selecting
 * a marker zooms the y-axis to that percentile, so the long tail stops
 * flattening the rest, and selecting a dot opens the issue beside the list.
 */

import React, { useMemo, useState } from 'react';
import {
  PERCENTILES,
  UNSET_COLOR,
  bucketColor,
  formatHours,
  type Percentile,
} from '../../../lib/insights';
import type { InsightBucket, InsightsRead } from '../../../types/Api';

/** Props for InsightsScatter. */
export interface InsightsScatterProps {
  data: InsightsRead;
  /** Opens one issue, as a dot click asks. */
  onOpenIssue?: ((issue: { id: string; key: string }) => void) | undefined;
}

const WIDTH = 320;
const HEIGHT = 200;
const LEFT = 36;
const TOP = 8;
const BOTTOM = 8;
const PLOT_WIDTH = WIDTH - LEFT - 4;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

const PERCENTILE_NAMES: Record<Percentile, string> = {
  p25: '25th',
  p50: '50th',
  p75: '75th',
  p95: '95th',
};

/** A stable offset in [-0.5, 0.5) for one id, so dots spread the same way on every read. */
const jitter = (id: string): number => {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return ((hash >>> 0) % 1000) / 1000 - 0.5;
};

/** The dots, the percentile strip and the bucket names of one time breakdown. */
export const InsightsScatter: React.FC<InsightsScatterProps> = ({
  data,
  onOpenIssue,
}) => {
  const [zoom, setZoom] = useState<Percentile | null>(null);
  const points = useMemo(() => data.points ?? [], [data.points]);
  const durations = data.durations;

  const columns = useMemo(
    () => new Map(data.groups.map((group, index) => [group.key ?? '', index])),
    [data.groups]
  );
  const segmentColors = useMemo(() => {
    const seen = new Map<string, InsightBucket>();
    for (const group of data.groups) {
      for (const segment of group.segments) {
        if (!seen.has(segment.key ?? '')) seen.set(segment.key ?? '', segment);
      }
    }
    return new Map(
      [...seen.entries()].map(([key, segment], index) => [
        key,
        bucketColor(segment, index),
      ])
    );
  }, [data.groups]);

  if (points.length === 0 || durations === undefined || durations === null) {
    return (
      <p className="px-1 py-6 text-center text-sm text-text-muted">
        No issues match this measure.
      </p>
    );
  }

  const maximum = durations.maximum ?? 0;
  const zoomed = zoom === null ? null : durations[zoom];
  const top = Math.max(zoomed ?? maximum, 1 / 60);
  const ceiling = zoomed === null ? top * 1.05 : top;
  const band = PLOT_WIDTH / Math.max(data.groups.length, 1);
  const y = (hours: number): number =>
    TOP + PLOT_HEIGHT * (1 - Math.min(hours, ceiling) / ceiling);
  const hidden = points.filter((point) => point.hours > ceiling).length;

  const colorOf = (group: string | null, segment: string | null): string => {
    if (data.segment_by !== null) {
      return segmentColors.get(segment ?? '') ?? UNSET_COLOR;
    }
    const index = columns.get(group ?? '') ?? 0;
    const bucket = data.groups[index];
    return bucket === undefined ? UNSET_COLOR : bucketColor(bucket, index);
  };

  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Percentiles" className="grid grid-cols-4 gap-1 px-1">
        {PERCENTILES.map((name) => {
          const value = durations[name];
          const active = zoom === name;
          return (
            <li key={name}>
              <button
                type="button"
                aria-pressed={active}
                disabled={value === null}
                title={
                  active
                    ? 'Show every issue'
                    : `Zoom to the ${PERCENTILE_NAMES[name]} percentile`
                }
                className={`flex w-full flex-col items-start rounded-md border px-2 py-1 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                  active
                    ? 'border-accent bg-raised'
                    : 'border-line hover:bg-raised'
                }`}
                onClick={() => {
                  setZoom(active ? null : name);
                }}
              >
                <span className="text-[10px] tracking-wide text-text-muted uppercase">
                  {name.toUpperCase()}
                </span>
                <span className="text-sm text-text tabular-nums">
                  {value === null ? '-' : formatHours(value)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <svg
        role="img"
        aria-label={`${String(points.length)} issues by duration`}
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        className="w-full"
      >
        {[0, 0.5, 1].map((share) => {
          const hours = ceiling * share;
          return (
            <g key={share}>
              <line
                x1={LEFT}
                x2={WIDTH - 4}
                y1={y(hours)}
                y2={y(hours)}
                className="stroke-line"
                strokeWidth={1}
              />
              <text
                x={LEFT - 4}
                y={y(hours) + 3}
                textAnchor="end"
                className="fill-text-muted text-[9px]"
              >
                {formatHours(hours)}
              </text>
            </g>
          );
        })}
        {PERCENTILES.map((name) => {
          const value = durations[name];
          if (value === null || value > ceiling) return null;
          return (
            <line
              key={name}
              data-percentile={name}
              x1={LEFT}
              x2={WIDTH - 4}
              y1={y(value)}
              y2={y(value)}
              className={zoom === name ? 'stroke-accent' : 'stroke-text-muted'}
              strokeDasharray="3 3"
              strokeWidth={1}
              opacity={0.6}
            />
          );
        })}
        {points.map((point) => {
          if (point.hours > ceiling) return null;
          const column = columns.get(point.group ?? '') ?? 0;
          const cx =
            LEFT + band * (column + 0.5 + jitter(point.issue_id) * 0.7);
          const label = `${point.key} ${point.title}, ${formatHours(point.hours)}`;
          const open = (): void => {
            onOpenIssue?.({ id: point.issue_id, key: point.key });
          };
          return (
            <circle
              key={`${point.issue_id}:${point.group ?? ''}`}
              role="button"
              tabIndex={0}
              aria-label={label}
              cx={cx}
              cy={y(point.hours)}
              r={3.5}
              fill={colorOf(point.group, point.segment)}
              className="cursor-pointer hover:stroke-accent focus:outline-none focus-visible:stroke-accent"
              strokeWidth={2}
              onClick={open}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  open();
                }
              }}
            >
              <title>{label}</title>
            </circle>
          );
        })}
      </svg>
      <ul
        aria-label="Buckets"
        className="grid gap-1 text-[10px] text-text-muted"
        style={{
          marginLeft: `${String((LEFT / WIDTH) * 100)}%`,
          gridTemplateColumns: `repeat(${String(Math.max(data.groups.length, 1))}, minmax(0, 1fr))`,
        }}
      >
        {data.groups.map((group) => {
          const median = group.durations?.p50 ?? null;
          const suffix =
            median === null ? '' : `, median ${formatHours(median)}`;
          return (
            <li
              key={group.key ?? ''}
              title={`${group.label}: ${String(group.issue_count)} issues${suffix}`}
              className="truncate text-center"
            >
              {group.label}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <p className="px-1 text-xs text-text-muted">
          {hidden} {hidden === 1 ? 'issue sits' : 'issues sit'} above this zoom.
        </p>
      )}
    </div>
  );
};

export default InsightsScatter;
