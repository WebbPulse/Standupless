/**
 * The breakdown table of the view insights panel: an across all row measuring
 * every issue once, then a row per group, with the measure and a column per
 * segment. It is the chart's figures in text, and its measure header sorts
 * both. A row on a filterable dimension narrows the list when clicked.
 */

import React from 'react';
import { LuArrowDown, LuArrowUp } from 'react-icons/lu';
import {
  FILTER_FOR,
  INSIGHT_DIMENSIONS,
  INSIGHT_MEASURES,
  acrossAllLabel,
  bucketColor,
  bucketFigure,
  isTimeMeasure,
  nextInsightsSort,
  segmentColumns,
  type InsightsSort,
} from '../../../lib/insights';
import type { FilterField } from '../../../lib/issueView';
import type { InsightBucket, InsightsRead } from '../../../types/Api';

/** Props for InsightsTable. */
export interface InsightsTableProps {
  data: InsightsRead;
  sort: InsightsSort;
  onSort: (sort: InsightsSort) => void;
  /** Narrows the list to one row, for dimensions with a list filter. */
  onPick?: ((field: FilterField, value: string) => void) | undefined;
}

const CELL = 'px-2 py-1.5 text-right text-xs tabular-nums whitespace-nowrap';
const NAME_CELL = 'max-w-44 px-2 py-1.5 text-left text-xs';
const HEAD = 'border-b border-line font-normal text-text-muted';

const ARIA_SORT: Record<'asc' | 'desc', 'ascending' | 'descending'> = {
  asc: 'ascending',
  desc: 'descending',
};

/** The table, in the order the groups arrive. */
export const InsightsTable: React.FC<InsightsTableProps> = ({
  data,
  sort,
  onSort,
  onPick,
}) => {
  const columns = segmentColumns(data);
  const field = FILTER_FOR[data.group_by];
  const sliceName =
    INSIGHT_DIMENSIONS.find((option) => option.value === data.group_by)
      ?.label ?? '';
  const measureName =
    INSIGHT_MEASURES.find((option) => option.value === data.measure)?.label ??
    '';
  const measureHead = isTimeMeasure(data.measure)
    ? `Average ${measureName.toLowerCase()}`
    : measureName;
  const whole: InsightBucket = {
    key: null,
    label: acrossAllLabel(data.group_by),
    color: null,
    value: data.total,
    issue_count: data.issue_count,
    durations: data.durations ?? null,
  };
  const SortIcon = sort === 'asc' ? LuArrowUp : LuArrowDown;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th scope="col" className={`${NAME_CELL} ${HEAD}`}>
              {sliceName}
            </th>
            <th
              scope="col"
              className={`p-0 text-right ${HEAD}`}
              {...(sort === null ? {} : { 'aria-sort': ARIA_SORT[sort] })}
            >
              <button
                type="button"
                className="inline-flex w-full items-center justify-end gap-1 px-2 py-1.5 text-xs whitespace-nowrap hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                onClick={() => {
                  onSort(nextInsightsSort(sort));
                }}
              >
                {sort !== null && (
                  <SortIcon aria-hidden="true" className="h-3 w-3" />
                )}
                {measureHead}
              </button>
            </th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={`${CELL} ${HEAD}`}>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: column.color }}
                  />
                  {column.bucket.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-line">
            <th
              scope="row"
              className={`${NAME_CELL} truncate font-medium text-text`}
            >
              {whole.label}
            </th>
            <td className={`${CELL} font-medium text-text`}>
              {bucketFigure(whole, data.measure)}
            </td>
            {columns.map((column) => (
              <td key={column.key} className={`${CELL} text-text-muted`}>
                {bucketFigure(column.bucket, data.measure)}
              </td>
            ))}
          </tr>
          {data.groups.map((group, index) => {
            const name = (
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: bucketColor(group, index) }}
                />
                <span className="truncate">{group.label}</span>
              </span>
            );
            return (
              <tr key={group.key ?? ''} className="hover:bg-raised">
                <th
                  scope="row"
                  className={`${NAME_CELL} font-normal text-text`}
                >
                  {field !== undefined && onPick !== undefined ? (
                    <button
                      type="button"
                      aria-label={`Filter the list to ${group.label}`}
                      className="flex w-full min-w-0 rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                      onClick={() => {
                        onPick(field, group.key ?? 'none');
                      }}
                    >
                      {name}
                    </button>
                  ) : (
                    name
                  )}
                </th>
                <td className={`${CELL} text-text`}>
                  {bucketFigure(group, data.measure)}
                </td>
                {columns.map((column) => (
                  <td key={column.key} className={`${CELL} text-text-muted`}>
                    {bucketFigure(
                      group.segments.find(
                        (segment) => (segment.key ?? '') === column.key
                      ),
                      data.measure
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default InsightsTable;
