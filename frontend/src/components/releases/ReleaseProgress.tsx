/**
 * How far a release's issues have come, as a thin bar split by status
 * category with the done count beside it. The bar reads only the counts the
 * listing carries, so a long list never fetches each release's issues.
 */

import React from 'react';
import { CATEGORY_DEFAULT_COLOR } from '../../lib/statusAppearance';
import type { StatusCategory } from '../../types/Api';
import Tooltip from '../ui/tooltip';

/** The order the segments run in, finished work first. */
const SEGMENTS: StatusCategory[] = [
  'completed',
  'started',
  'unstarted',
  'backlog',
  'cancelled',
];

/** How each category reads in the tooltip. */
const SEGMENT_LABELS: Record<StatusCategory, string> = {
  completed: 'done',
  started: 'in progress',
  unstarted: 'todo',
  backlog: 'backlog',
  cancelled: 'cancelled',
};

/** Props for ReleaseProgress: the issue total and the per category counts. */
export interface ReleaseProgressProps {
  total: number;
  counts: Partial<Record<StatusCategory, number>>;
}

/** The issue count, a stacked status bar and a tooltip that spells it out. */
export const ReleaseProgress: React.FC<ReleaseProgressProps> = ({
  total,
  counts,
}) => {
  const counted = SEGMENTS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const scale = Math.max(total, counted);
  const done = counts.completed ?? 0;
  const parts = SEGMENTS.filter((key) => (counts[key] ?? 0) > 0).map(
    (key) => `${String(counts[key] ?? 0)} ${SEGMENT_LABELS[key]}`
  );
  const issues = total === 1 ? '1 issue' : `${String(total)} issues`;
  const text = parts.length === 0 ? issues : `${issues}: ${parts.join(', ')}`;
  return (
    <Tooltip text={text} side="top" className="relative z-10">
      <span
        aria-label={text}
        className="flex items-center gap-2 text-xs text-text-muted tabular-nums"
      >
        <span
          aria-hidden="true"
          className="flex h-1.5 w-14 overflow-hidden rounded-full bg-line"
        >
          {scale > 0 &&
            SEGMENTS.map((key) => {
              const value = counts[key] ?? 0;
              return value === 0 ? null : (
                <span
                  key={key}
                  className="h-full"
                  style={{
                    width: `${String((value / scale) * 100)}%`,
                    background: CATEGORY_DEFAULT_COLOR[key],
                  }}
                />
              );
            })}
        </span>
        <span aria-hidden="true">
          {counted === 0 ? issues : `${String(done)}/${String(total)}`}
        </span>
      </span>
    </Tooltip>
  );
};

export default ReleaseProgress;
