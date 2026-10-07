/**
 * The insights panel beside an issue list: the issues the list's filter
 * selects, counted or summed in points and grouped by one property, with an
 * optional second property splitting each bar. It sends the same query the
 * list runs, so the bars always describe the rows on screen, and a bar on a
 * filterable property narrows the list to it when clicked.
 */

import React, { useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuX } from 'react-icons/lu';
import { getInsights, type InsightsQuery } from '../../../api/insights';
import { errorMessage } from '../../../lib/errors';
import {
  FILTER_FOR,
  INSIGHT_DIMENSIONS,
  INSIGHTS_POLL_MS,
  UNSET_COLOR,
  bucketColor,
  formatMeasure,
} from '../../../lib/insights';
import type { FilterField } from '../../../lib/issueView';
import type {
  InsightBucket,
  InsightDimension,
  InsightGroup,
  InsightMeasure,
  InsightsRead,
} from '../../../types/Api';
import { IconButton } from '../../ui/button';
import { Select } from '../../ui/select';
import Spinner from '../../ui/spinner';

/** Props for InsightsChart. */
export interface InsightsChartProps {
  data: InsightsRead;
  /** Narrows the list to one bar, for dimensions with a list filter. */
  onPick?: ((field: FilterField, value: string) => void) | undefined;
}

/** One stacked or solid track under a bar's name, scaled to the largest bar. */
const Track: React.FC<{
  group: InsightGroup;
  index: number;
  max: number;
  segmentColors: Map<string, string>;
}> = ({ group, index, max, segmentColors }) => {
  const width = max === 0 ? 0 : (group.value / max) * 100;
  return (
    <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <span className="flex h-full" style={{ width: `${width}%` }}>
        {group.segments.length === 0 ? (
          <span
            className="h-full w-full"
            style={{ backgroundColor: bucketColor(group, index) }}
          />
        ) : (
          group.segments.map((segment) => (
            <span
              key={segment.key ?? ''}
              className="h-full"
              style={{
                width:
                  group.value === 0
                    ? '0%'
                    : `${(segment.value / group.value) * 100}%`,
                backgroundColor:
                  segmentColors.get(segment.key ?? '') ?? UNSET_COLOR,
              }}
            />
          ))
        )}
      </span>
    </span>
  );
};

/** The bars of one breakdown, with a legend when the bars are segmented. */
export const InsightsChart: React.FC<InsightsChartProps> = ({
  data,
  onPick,
}) => {
  const max = data.groups.reduce((top, group) => Math.max(top, group.value), 0);
  const legend = useMemo(() => {
    const seen = new Map<string, InsightBucket>();
    for (const group of data.groups) {
      for (const segment of group.segments) {
        if (!seen.has(segment.key ?? '')) seen.set(segment.key ?? '', segment);
      }
    }
    return [...seen.entries()].map(([key, segment], index) => ({
      key,
      label: segment.label,
      color: bucketColor(segment, index),
    }));
  }, [data.groups]);
  const segmentColors = useMemo(
    () => new Map(legend.map((entry) => [entry.key, entry.color])),
    [legend]
  );
  const field = FILTER_FOR[data.group_by];

  if (data.groups.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-sm text-text-muted">
        No issues match this filter.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {legend.length > 0 && (
        <ul aria-label="Segments" className="flex flex-wrap gap-x-3 gap-y-1">
          {legend.map((entry) => (
            <li
              key={entry.key}
              className="flex items-center gap-1.5 text-xs text-text-muted"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
      <ul aria-label="Breakdown" className="flex flex-col gap-1">
        {data.groups.map((group, index) => {
          const figure = formatMeasure(group.value, data.measure);
          const detail =
            data.measure === 'points'
              ? `${figure} over ${formatMeasure(group.issue_count, 'count')}`
              : figure;
          const tip = [
            detail,
            ...group.segments.map(
              (segment) =>
                `${segment.label}: ${formatMeasure(segment.value, data.measure)}`
            ),
          ].join('\n');
          const content = (
            <>
              <span className="flex w-full items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-left text-sm text-text">
                  {group.label}
                </span>
                <span className="shrink-0 text-xs text-text-muted tabular-nums">
                  {group.value}
                </span>
              </span>
              <Track
                group={group}
                index={index}
                max={max}
                segmentColors={segmentColors}
              />
            </>
          );
          return (
            <li key={group.key ?? ''}>
              {field !== undefined && onPick !== undefined ? (
                <button
                  type="button"
                  title={tip}
                  aria-label={`${group.label}, ${detail}. Filter the list to it`}
                  className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                  onClick={() => {
                    onPick(field, group.key ?? 'none');
                  }}
                >
                  {content}
                </button>
              ) : (
                <div
                  title={tip}
                  aria-label={`${group.label}, ${detail}`}
                  className="flex w-full flex-col gap-1 px-2 py-1.5"
                >
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** Props for InsightsPanel. */
export interface InsightsPanelProps {
  workspaceId: string;
  /** Names what the list belongs to, for the read's key. */
  scopeKey: string;
  /** The list's filters, exactly as the list sends them, without its sort. */
  filters: Omit<InsightsQuery, 'group_by' | 'segment_by' | 'measure'>;
  onPick?: ((field: FilterField, value: string) => void) | undefined;
  onClose: () => void;
  className?: string;
}

/** The panel: the pickers, the total and the chart, read live. */
export const InsightsPanel: React.FC<InsightsPanelProps> = ({
  workspaceId,
  scopeKey,
  filters,
  onPick,
  onClose,
  className = '',
}) => {
  const auth = useQueryAuth();
  const [groupBy, setGroupBy] = useState<InsightDimension>('status');
  const [segmentBy, setSegmentBy] = useState<InsightDimension | ''>('');
  const [measure, setMeasure] = useState<InsightMeasure>('count');

  const query = useMemo<InsightsQuery>(
    () => ({
      ...filters,
      group_by: groupBy,
      measure,
      ...(segmentBy === '' || segmentBy === groupBy
        ? {}
        : { segment_by: segmentBy }),
    }),
    [filters, groupBy, segmentBy, measure]
  );
  const queryJson = JSON.stringify(query);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getInsights(workspaceId, query, signal),
    {
      intervalMs: INSIGHTS_POLL_MS,
      enabled: workspaceId !== '',
      queryKey: ['insights', workspaceId, scopeKey, queryJson],
      auth,
    }
  );

  return (
    <aside
      aria-label="Insights"
      className={`flex min-h-0 flex-col bg-surface ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="flex-1 text-sm font-medium text-text">Insights</h2>
        <IconButton size="sm" label="Close insights" onClick={onClose}>
          <LuX aria-hidden="true" className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="grid grid-cols-3 gap-2 border-b border-line px-3 py-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
          Group by
          <Select
            value={groupBy}
            onChange={(event) => {
              setGroupBy(event.target.value as InsightDimension);
            }}
          >
            {INSIGHT_DIMENSIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
          Segment by
          <Select
            value={segmentBy === groupBy ? '' : segmentBy}
            onChange={(event) => {
              setSegmentBy(event.target.value as InsightDimension | '');
            }}
          >
            <option value="">None</option>
            {INSIGHT_DIMENSIONS.filter(
              (option) => option.value !== groupBy
            ).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
          Measure
          <Select
            value={measure}
            onChange={(event) => {
              setMeasure(event.target.value as InsightMeasure);
            }}
          >
            <option value="count">Issue count</option>
            <option value="points">Estimate points</option>
          </Select>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {data === undefined || data === null ? (
          isLoading || error === undefined || error === null ? (
            <Spinner label="Loading insights" />
          ) : (
            <p className="px-2 py-6 text-center text-sm text-text-muted">
              {errorMessage(error, 'Insights could not be loaded.')}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <p className="px-2 text-xs text-text-muted">
              {data.measure === 'points'
                ? `${formatMeasure(data.total, 'points')} over ${formatMeasure(data.issue_count, 'count')}`
                : formatMeasure(data.total, 'count')}
            </p>
            {data.truncated && (
              <p className="mx-2 rounded-md border border-line px-2 py-1.5 text-xs text-text-muted">
                Counted the first {data.row_cap} issues only. Narrow the filter
                for exact figures.
              </p>
            )}
            <InsightsChart data={data} onPick={onPick} />
          </div>
        )}
      </div>
    </aside>
  );
};

export default InsightsPanel;
