/**
 * The view insights panel beside an issue list: the issues the list's filter
 * selects, counted, summed in points or timed, sliced by one property, with an
 * optional second property segmenting each column. A stacked chart and a
 * breakdown table show the figures, and a time measure draws a scatterplot of
 * issues instead of columns. It sends the same query the list runs, so it
 * always describes the rows on screen, and a column or row on a filterable
 * property narrows the list to it when clicked. The panel opens on the default
 * a view or a team saved for everyone, and the viewer's own picks win over it
 * field by field and come back when the panel reopens. InsightsChart is the
 * compact sideways bars dashboards draw.
 */

import React, { useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuCheck,
  LuEllipsis,
  LuLayoutDashboard,
  LuMaximize2,
  LuMinimize2,
  LuSlidersHorizontal,
} from 'react-icons/lu';
import { getInsights, type InsightsQuery } from '../../../api/insights';
import { usePeekIssue } from '../../../hooks/usePeekIssue';
import { eventMatches, parseKeys } from '../../../hooks/useShortcuts';
import type { WidgetSource } from '../../../lib/dashboards';
import { errorMessage } from '../../../lib/errors';
import {
  FILTER_FOR,
  INSIGHT_DIMENSIONS,
  INSIGHT_MEASURES,
  INSIGHTS_PANEL_KEYS,
  INSIGHTS_POLL_MS,
  UNSET_COLOR,
  bucketColor,
  clearInsightsPicks,
  formatMeasure,
  insightsDisplayFromPrefs,
  insightsHeadline,
  insightsPrefsFromDisplay,
  isTimeMeasure,
  readInsightsPicks,
  sortGroups,
  writeInsightsPicks,
  type InsightsLayout,
  type InsightsPicks,
  type InsightsPrefs,
  type InsightsSort,
} from '../../../lib/insights';
import type { FilterField } from '../../../lib/issueView';
import { showErrorToast, showToast } from '../../../lib/toast';
import type {
  InsightBucket,
  InsightDimension,
  InsightGroup,
  InsightMeasure,
  InsightsDisplay,
  InsightsRead,
} from '../../../types/Api';
import AddToDashboardDialog from '../../dashboards/AddToDashboardDialog';
import { IconButton } from '../../ui/button';
import { Menu, MenuItem, MenuSeparator } from '../../ui/menu';
import { Select } from '../../ui/select';
import Spinner from '../../ui/spinner';
import InsightsBars from './InsightsBars';
import InsightsScatter from './InsightsScatter';
import InsightsTable from './InsightsTable';

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

const LAYOUTS: { value: InsightsLayout; label: string }[] = [
  { value: 'both', label: 'Chart and table' },
  { value: 'chart', label: 'Chart only' },
  { value: 'table', label: 'Table only' },
];

const PICKER_LABEL = 'flex min-w-0 flex-col gap-1 text-xs text-text-muted';

const TOGGLE_TOKEN = parseKeys(INSIGHTS_PANEL_KEYS)[0];

/** The panel configuration a view or a team saved for everyone, and how to change it. */
export interface InsightsDefaultControl {
  /** The saved configuration, null when none is set. */
  display: InsightsDisplay | null;
  /**
   * Saves a configuration or clears it with null, settling once `display`
   * reads the change. Left out for a viewer who may not change it, which hides
   * the controls.
   */
  save?: ((display: InsightsDisplay | null) => Promise<void>) | undefined;
}

/** Props for InsightsPanel. */
export interface InsightsPanelProps {
  workspaceId: string;
  /** Names what the list belongs to, for the read's key and the kept picks. */
  scopeKey: string;
  /** The list's filters, exactly as the list sends them, without its sort. */
  filters: Omit<InsightsQuery, 'group_by' | 'segment_by' | 'measure'>;
  onPick?: ((field: FilterField, value: string) => void) | undefined;
  /** What a widget added from this panel reads, which offers Add to dashboard. */
  widget?: WidgetSource | undefined;
  /** The default for everyone this list has, for a list that can hold one. */
  sharedDefault?: InsightsDefaultControl | undefined;
  /** Whether the panel has taken the list's room. */
  expanded?: boolean | undefined;
  /** Grows the panel over the list or gives the room back, which offers the control. */
  onToggleExpanded?: (() => void) | undefined;
  /** Closes the panel, for the keys pressed while a picker holds focus. */
  onClose: () => void;
  className?: string;
}

/** The panel: the headline, the pickers, the chart and the table, read live. */
export const InsightsPanel: React.FC<InsightsPanelProps> = ({
  workspaceId,
  scopeKey,
  filters,
  onPick,
  widget,
  sharedDefault,
  expanded = false,
  onToggleExpanded,
  onClose,
  className = '',
}) => {
  const auth = useQueryAuth();
  const [adding, setAdding] = useState(false);
  const { peekIssue } = usePeekIssue();
  const [picks, setPicks] = useState<InsightsPicks>(() =>
    readInsightsPicks(workspaceId, scopeKey)
  );
  const [sort, setSort] = useState<InsightsSort>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const shared = insightsPrefsFromDisplay(sharedDefault?.display);
  const prefs: InsightsPrefs = { ...shared, ...picks };
  const { measure, groupBy, segmentBy, layout } = prefs;
  const segment = segmentBy === groupBy ? '' : segmentBy;
  const display = insightsDisplayFromPrefs(prefs);
  const matchesDefault =
    JSON.stringify(display) ===
    JSON.stringify(insightsDisplayFromPrefs(shared));
  const hasDefault =
    sharedDefault?.display !== null && sharedDefault?.display !== undefined;
  const saveDefault = sharedDefault?.save;

  const change = (patch: Partial<InsightsPrefs>): void => {
    const next = { ...picks, ...patch };
    setPicks(next);
    writeInsightsPicks(workspaceId, scopeKey, next);
  };

  const reset = (): void => {
    setPicks({});
    clearInsightsPicks(workspaceId, scopeKey);
    setSort(null);
  };

  /**
   * Saves what is drawn for everyone, which leaves the viewer following it with
   * no picks of their own. The stored picks go first, because saving a view
   * remounts the page and the new panel reads them as it opens; a refused save
   * puts them back, and the picks in hand keep the panel steady until then.
   */
  const setDefaultForEveryone = async (): Promise<void> => {
    if (saveDefault === undefined) return;
    setSavingDefault(true);
    clearInsightsPicks(workspaceId, scopeKey);
    try {
      await saveDefault(display);
      setPicks({});
      showToast('Saved as the default for everyone.');
    } catch (failure) {
      writeInsightsPicks(workspaceId, scopeKey, picks);
      showErrorToast(
        errorMessage(failure, 'Could not save the default for everyone.')
      );
    } finally {
      setSavingDefault(false);
    }
  };

  /** Drops the default for everyone, which leaves the viewer's own picks alone. */
  const clearDefaultForEveryone = async (): Promise<void> => {
    if (saveDefault === undefined) return;
    setSavingDefault(true);
    try {
      await saveDefault(null);
      showToast('Default cleared.');
    } catch (failure) {
      showErrorToast(
        errorMessage(failure, 'Could not clear the default for everyone.')
      );
    } finally {
      setSavingDefault(false);
    }
  };

  const query = useMemo<InsightsQuery>(
    () => ({
      ...filters,
      group_by: groupBy,
      measure,
      ...(segment === '' ? {} : { segment_by: segment }),
    }),
    [filters, groupBy, segment, measure]
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

  const sorted = useMemo<InsightsRead | null>(
    () =>
      data === undefined || data === null
        ? null
        : { ...data, groups: sortGroups(data.groups, data.measure, sort) },
    [data, sort]
  );
  const headline = sorted === null ? null : insightsHeadline(sorted);

  return (
    <aside
      aria-label="View insights"
      className={`flex min-h-0 flex-col bg-surface ${className}`}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLSelectElement &&
          TOGGLE_TOKEN !== undefined &&
          eventMatches(event.nativeEvent, TOGGLE_TOKEN)
        ) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <h2 className="sr-only">View insights</h2>
        <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
          {headline !== null && (
            <>
              <span className="text-2xl font-semibold text-text tabular-nums">
                {headline.figure}
              </span>
              <span className="text-xs text-text-muted">{headline.unit}</span>
            </>
          )}
        </p>
        {onToggleExpanded !== undefined && (
          <IconButton
            size="sm"
            label={expanded ? 'Collapse insights' : 'Expand insights'}
            aria-pressed={expanded}
            onClick={onToggleExpanded}
          >
            {expanded ? (
              <LuMinimize2 aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <LuMaximize2 aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </IconButton>
        )}
        <Menu
          label="Insights settings"
          align="end"
          trigger={(props) => (
            <IconButton {...props} size="sm" label="Insights settings">
              <LuSlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
            </IconButton>
          )}
        >
          {LAYOUTS.map((option) => (
            <MenuItem
              key={option.value}
              textValue={option.label}
              onSelect={() => {
                change({ layout: option.value });
              }}
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {layout === option.value && (
                  <LuCheck aria-label="Selected" className="h-3.5 w-3.5" />
                )}
              </span>
              {option.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={reset}>Reset to defaults</MenuItem>
          {saveDefault !== undefined && (
            <MenuItem
              disabled={savingDefault || matchesDefault}
              onSelect={() => {
                void setDefaultForEveryone();
              }}
            >
              Set default for everyone
            </MenuItem>
          )}
          {saveDefault !== undefined && hasDefault && (
            <MenuItem
              disabled={savingDefault}
              onSelect={() => {
                void clearDefaultForEveryone();
              }}
            >
              Clear default for everyone
            </MenuItem>
          )}
        </Menu>
        {widget !== undefined && (
          <Menu
            label="Insights actions"
            align="end"
            trigger={(props) => (
              <IconButton {...props} size="sm" label="Insights actions">
                <LuEllipsis aria-hidden="true" className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <MenuItem
              onSelect={() => {
                setAdding(true);
              }}
            >
              <LuLayoutDashboard aria-hidden="true" className="h-3.5 w-3.5" />
              Add to dashboard
            </MenuItem>
          </Menu>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 border-b border-line px-3 pb-3">
        <label className={PICKER_LABEL}>
          Measure
          <Select
            value={measure}
            onChange={(event) => {
              change({ measure: event.target.value as InsightMeasure });
            }}
          >
            {INSIGHT_MEASURES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className={PICKER_LABEL}>
          Slice
          <Select
            value={groupBy}
            onChange={(event) => {
              change({ groupBy: event.target.value as InsightDimension });
            }}
          >
            {INSIGHT_DIMENSIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className={PICKER_LABEL}>
          Segment
          <Select
            value={segment}
            onChange={(event) => {
              change({
                segmentBy: event.target.value as InsightDimension | '',
              });
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
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {sorted === null ? (
          isLoading || error === undefined || error === null ? (
            <Spinner label="Loading insights" />
          ) : (
            <p className="py-6 text-center text-sm text-text-muted">
              {errorMessage(error, 'Insights could not be loaded.')}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-4">
            {sorted.truncated && (
              <p className="rounded-md border border-line px-2 py-1.5 text-xs text-text-muted">
                Counted the first {sorted.row_cap} issues only. Narrow the
                filter for exact figures.
              </p>
            )}
            {isTimeMeasure(sorted.measure) ? (
              (layout !== 'table' || sorted.points?.length === 0) && (
                <InsightsScatter data={sorted} onOpenIssue={peekIssue} />
              )
            ) : sorted.groups.length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">
                No issues match this filter.
              </p>
            ) : (
              layout !== 'table' && (
                <InsightsBars
                  data={sorted}
                  labelled={layout === 'chart' || expanded}
                  onPick={onPick}
                />
              )
            )}
            {layout !== 'chart' && sorted.groups.length > 0 && (
              <InsightsTable
                data={sorted}
                sort={sort}
                onSort={setSort}
                onPick={onPick}
              />
            )}
          </div>
        )}
      </div>
      {adding && widget !== undefined && (
        <AddToDashboardDialog
          workspaceId={workspaceId}
          widget={{
            ...widget,
            kind: 'chart',
            group_by: groupBy,
            segment_by: segment === '' ? null : segment,
            measure,
          }}
          onClose={() => {
            setAdding(false);
          }}
        />
      )}
    </aside>
  );
};

export default InsightsPanel;
