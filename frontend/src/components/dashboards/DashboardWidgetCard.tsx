/**
 * One dashboard widget: a card that reads its own breakdown and draws it as
 * bars, a table or a single number, with the insights panel's chart and
 * scatterplot reused for the drawing. Cards on an editable dashboard can be
 * dragged into a new order and carry an edit menu.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuEllipsis,
  LuGripVertical,
  LuPencil,
  LuTrash2,
  LuMaximize2,
  LuMinimize2,
} from 'react-icons/lu';
import { getWidgetInsights } from '../../api/dashboards';
import { usePeekIssue } from '../../hooks/usePeekIssue';
import { cn } from '../../lib/cn';
import { DASHBOARD_POLL_MS, widgetTitle } from '../../lib/dashboards';
import { errorMessage } from '../../lib/errors';
import {
  INSIGHT_DIMENSIONS,
  formatHours,
  formatMeasure,
  isTimeMeasure,
} from '../../lib/insights';
import { dashboardWidgetKey } from '../../lib/queryKeys';
import type { DashboardWidgetRead, InsightsRead } from '../../types/Api';
import { InsightsChart } from '../issues/view/InsightsPanel';
import InsightsScatter from '../issues/view/InsightsScatter';
import { IconButton } from '../ui/button';
import { Menu, MenuItem, MenuSeparator } from '../ui/menu';
import { SkeletonRows } from '../ui/skeleton';

/** The headline figure of a breakdown: the average under a time measure, else the total. */
const headline = (data: InsightsRead): string => {
  if (isTimeMeasure(data.measure)) {
    const average = data.durations?.average;
    return average === null || average === undefined
      ? 'No data'
      : formatHours(average);
  }
  return data.total.toLocaleString();
};

/** What the headline figure counts, in words. */
const headlineCaption = (data: InsightsRead): string => {
  if (isTimeMeasure(data.measure))
    return `Average over ${formatMeasure(data.issue_count, 'count')}`;
  if (data.measure === 'points')
    return `Points over ${formatMeasure(data.issue_count, 'count')}`;
  return 'Issues';
};

/** The bars of a breakdown as rows of a table. */
const BreakdownTable: React.FC<{ data: InsightsRead }> = ({ data }) => {
  const dimension =
    INSIGHT_DIMENSIONS.find((option) => option.value === data.group_by)
      ?.label ?? 'Group';
  const timed = isTimeMeasure(data.measure);
  if (data.groups.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-text-muted">
        No issues match this filter.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-text-muted">
          <th scope="col" className="py-1.5 font-normal">
            {dimension}
          </th>
          <th scope="col" className="py-1.5 text-right font-normal">
            Issues
          </th>
          <th scope="col" className="py-1.5 text-right font-normal">
            {timed ? 'Median' : data.measure === 'points' ? 'Points' : 'Share'}
          </th>
        </tr>
      </thead>
      <tbody>
        {data.groups.map((group) => (
          <tr
            key={group.key ?? ''}
            className="border-b border-line last:border-0"
          >
            <td className="max-w-0 truncate py-1.5 text-text">{group.label}</td>
            <td className="py-1.5 text-right text-text-muted tabular-nums">
              {group.issue_count}
            </td>
            <td className="py-1.5 text-right text-text-muted tabular-nums">
              {timed
                ? group.durations?.p50 === null ||
                  group.durations?.p50 === undefined
                  ? ''
                  : formatHours(group.durations.p50)
                : data.measure === 'points'
                  ? group.value
                  : data.total === 0
                    ? ''
                    : `${Math.round((group.value / data.total) * 100)}%`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** Props for DashboardWidgetCard. */
export interface DashboardWidgetCardProps {
  workspaceId: string;
  dashboardId: string;
  /** Changes whenever the dashboard does, so the figures are read again. */
  version: string;
  widget: DashboardWidgetRead;
  sourceLabel: string;
  canEdit: boolean;
  dragging: boolean;
  onEdit: () => void;
  onResize: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
}

/** One widget card. */
export const DashboardWidgetCard: React.FC<DashboardWidgetCardProps> = ({
  workspaceId,
  dashboardId,
  version,
  widget,
  sourceLabel,
  canEdit,
  dragging,
  onEdit,
  onResize,
  onRemove,
  onDragStart,
  onDragEnter,
  onDragEnd,
}) => {
  const auth = useQueryAuth();
  const { peekIssue } = usePeekIssue();
  const title = widgetTitle(widget);
  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      getWidgetInsights(workspaceId, dashboardId, widget.widget_id, signal),
    {
      intervalMs: DASHBOARD_POLL_MS,
      enabled: workspaceId !== '',
      queryKey: dashboardWidgetKey(
        workspaceId,
        dashboardId,
        widget.widget_id,
        version
      ),
      auth,
    }
  );

  return (
    <section
      aria-label={title}
      draggable={canEdit}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', widget.widget_id);
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group flex min-h-64 min-w-0 flex-col rounded-md border border-line bg-surface',
        widget.size === 'full' ? 'lg:col-span-2' : '',
        dragging ? 'opacity-50' : ''
      )}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        {canEdit && (
          <LuGripVertical
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 cursor-grab text-text-faint"
          />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-text">{title}</h3>
          <p className="truncate text-xs text-text-faint">{sourceLabel}</p>
        </div>
        {canEdit && (
          <Menu
            label={`Actions for ${title}`}
            align="end"
            trigger={(props) => (
              <IconButton
                {...props}
                label={`Actions for ${title}`}
                size="sm"
                className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <LuEllipsis aria-hidden="true" className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <MenuItem onSelect={onEdit}>
              <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
              Edit widget
            </MenuItem>
            <MenuItem onSelect={onResize}>
              {widget.size === 'full' ? (
                <LuMinimize2 aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <LuMaximize2 aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {widget.size === 'full' ? 'Half width' : 'Full width'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={onRemove}>
              <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Remove widget
            </MenuItem>
          </Menu>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {data === null ? (
          isLoading || error === null ? (
            <SkeletonRows />
          ) : (
            <p className="py-6 text-center text-sm text-text-muted">
              {errorMessage(error, 'This widget could not be loaded.')}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-3">
            {widget.kind === 'metric' ? (
              <div className="flex flex-1 flex-col items-start justify-center gap-1 py-6">
                <span className="text-4xl font-semibold text-text tabular-nums">
                  {headline(data)}
                </span>
                <span className="text-xs text-text-muted">
                  {headlineCaption(data)}
                </span>
              </div>
            ) : (
              <>
                <p className="text-xs text-text-muted">
                  {headline(data)} {headlineCaption(data).toLowerCase()}
                </p>
                {widget.kind === 'table' ? (
                  <BreakdownTable data={data} />
                ) : isTimeMeasure(data.measure) ? (
                  <InsightsScatter data={data} onOpenIssue={peekIssue} />
                ) : (
                  <InsightsChart data={data} />
                )}
              </>
            )}
            {data.truncated && (
              <p className="rounded-md border border-line px-2 py-1.5 text-xs text-text-muted">
                Counted the first {data.row_cap} issues only.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

export default DashboardWidgetCard;
