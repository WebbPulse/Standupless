/**
 * What the dashboard pages share: the wording of a widget's kind, size and
 * source, the widget an insights panel adds, and how a dashboard's shared
 * filter reads as chips. Held apart from the components so each component
 * file exports only components.
 */

import { invalidateQueries } from '@webbpulse/api-client/react';
import { moveDashboard, updateDashboard } from '../api/dashboards';
import type { IssueListFilters } from '../api/issues';
import type { SavedViewDisplayRead } from '../api/views';
import {
  INSIGHT_DIMENSIONS,
  INSIGHT_MEASURES,
  insightsFilters,
} from './insights';
import {
  sameViewState,
  stateToViewFilter,
  viewToState,
  type ViewState,
} from './issueView';
import { PRIORITY_LABELS } from './issueDisplay';
import { dashboardKey, dashboardsKey } from './queryKeys';
import type {
  DashboardRead,
  DashboardScope,
  DashboardWidgetCreate,
  DashboardWidgetKind,
  DashboardWidgetRead,
  DashboardWidgetSize,
  IssuePriority,
  TeamRead,
} from '../types/Api';

/** What the dashboard form hands back. */
export interface DashboardDetails {
  name: string;
  description: string | null;
  scope: DashboardScope;
  teamId: string | null;
}

/** How often a widget's figures are read again. */
export const DASHBOARD_POLL_MS = 120000;

/** The most widgets one dashboard holds, as the server caps it. */
export const DASHBOARD_WIDGETS_MAX = 24;

/** The widget kinds in the order the pickers offer them. */
export const WIDGET_KINDS: { value: DashboardWidgetKind; label: string }[] = [
  { value: 'chart', label: 'Bar chart' },
  { value: 'table', label: 'Table' },
  { value: 'metric', label: 'Single number' },
];

/** The widget sizes, with their wording. */
export const WIDGET_SIZES: { value: DashboardWidgetSize; label: string }[] = [
  { value: 'half', label: 'Half width' },
  { value: 'full', label: 'Full width' },
];

/** The scopes a dashboard can be filed under, with their wording. */
export const DASHBOARD_SCOPES: { value: DashboardScope; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'team', label: 'Team' },
  { value: 'workspace', label: 'Workspace' },
];

/** The source and filter part of a widget, as an issue list hands it over. */
export type WidgetSource = Pick<
  DashboardWidgetCreate,
  'source' | 'team_id' | 'view_id' | 'include_sub_teams' | 'filter'
>;

/**
 * The widget an insights panel adds for the list it sits beside: the list's
 * saved view, its one team, or the workspace, with the list's filter. Hidden
 * closed issues and sub-issues stay hidden, as they do in the panel's bars.
 * A view whose list is unchanged keeps an empty filter, so later edits to the
 * view carry through to the widget.
 */
export const widgetSourceFor = (
  state: ViewState,
  scope: IssueListFilters,
  view?: SavedViewDisplayRead
): WidgetSource => {
  const filter: Record<string, unknown> = {
    ...stateToViewFilter(state, scope),
  };
  const shown = insightsFilters(state, scope);
  if (shown.status_category_not !== undefined)
    filter['status_category_not'] = shown.status_category_not;
  if (shown.parent_id !== undefined) filter['parent_id'] = shown.parent_id;
  delete filter['view_id'];
  if (view !== undefined) {
    delete filter['team_id'];
    const unchanged = sameViewState(state, viewToState(view));
    return {
      source: 'view',
      view_id: view.view_id,
      filter: unchanged ? {} : filter,
    };
  }
  const teamId = typeof scope.team_id === 'string' ? scope.team_id : undefined;
  if (teamId !== undefined) {
    delete filter['team_id'];
    return {
      source: 'team',
      team_id: teamId,
      include_sub_teams: scope.include_sub_teams === true,
      filter,
    };
  }
  return { source: 'workspace', filter };
};

/** The name a widget shows: its own title, or what it measures and groups by. */
export const widgetTitle = (widget: DashboardWidgetRead): string => {
  if (widget.title !== null && widget.title.trim() !== '') return widget.title;
  const measure =
    INSIGHT_MEASURES.find((option) => option.value === widget.measure)?.label ??
    'Issue count';
  if (widget.kind === 'metric') return measure;
  const group =
    INSIGHT_DIMENSIONS.find((option) => option.value === widget.group_by)
      ?.label ?? 'Status';
  return `${measure} by ${group.toLowerCase()}`;
};

/** Where a widget reads from, in words. */
export const widgetSourceLabel = (
  widget: DashboardWidgetRead,
  teams: TeamRead[],
  viewName?: string
): string => {
  if (widget.source === 'view') return viewName ?? 'Saved view';
  if (widget.source === 'team') {
    const name =
      teams.find((team) => team.id === widget.team_id)?.name ?? 'Team';
    return widget.include_sub_teams ? `${name} and sub-teams` : name;
  }
  return 'All teams';
};

/** Where a dashboard is filed, in words. */
export const dashboardLocation = (
  dashboard: DashboardRead,
  teams: TeamRead[]
): string => {
  if (dashboard.scope === 'personal') return 'Personal';
  if (dashboard.scope === 'workspace') return 'Workspace';
  return teams.find((team) => team.id === dashboard.team_id)?.name ?? 'Team';
};

/** One chip of a dashboard's shared filter. */
export interface FilterChip {
  key: string;
  label: string;
}

const FILTER_NAMES: Record<string, string> = {
  team_id: 'Team',
  team_id_in: 'Teams',
  priority: 'Priority',
  q: 'Text',
  assignee_id: 'Assignee',
  label_id: 'Label',
  project_id: 'Project',
  cycle_id: 'Cycle',
  status_category: 'Status type',
  created_after: 'Created after',
  created_before: 'Created before',
};

const asValues = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => String(item))
    : value === undefined || value === null
      ? []
      : [String(value)];

/** A dashboard filter as chips, team and priority values resolved to names. */
export const filterChips = (
  filter: Record<string, unknown>,
  teams: TeamRead[]
): FilterChip[] =>
  Object.entries(filter).map(([key, value]) => {
    const name = FILTER_NAMES[key] ?? key.replace(/_/g, ' ');
    const values = asValues(value).map((item) => {
      if (key === 'team_id' || key === 'team_id_in')
        return teams.find((team) => team.id === item)?.name ?? item;
      if (key === 'priority' && item in PRIORITY_LABELS)
        return PRIORITY_LABELS[item as IssuePriority];
      return item;
    });
    return {
      key,
      label:
        key === 'groups' ? 'Filter groups' : `${name}: ${values.join(', ')}`,
    };
  });

/** The widget ids in order with one moved to where another sits. */
export const movedOrder = (
  ids: string[],
  moving: string,
  target: string
): string[] => {
  const from = ids.indexOf(moving);
  const to = ids.indexOf(target);
  if (from === -1 || to === -1 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, moving);
  return next;
};

/** Saves a dashboard's details, moving it when its location changed. */
export const saveDashboardDetails = async (
  workspaceId: string,
  dashboard: DashboardRead,
  details: DashboardDetails
): Promise<DashboardRead> => {
  let saved = await updateDashboard(workspaceId, dashboard.id, {
    name: details.name,
    description: details.description,
  });
  if (
    details.scope !== dashboard.scope ||
    (details.scope === 'team' && details.teamId !== dashboard.team_id)
  ) {
    saved = await moveDashboard(workspaceId, dashboard.id, {
      scope: details.scope,
      team_id: details.teamId,
    });
  }
  return saved;
};

/** Clears every cached dashboards list and the one dashboard, so each re-reads. */
export const refreshDashboards = (
  workspaceId: string,
  teamId: string,
  dashboardId?: string
): void => {
  invalidateQueries([
    dashboardsKey(workspaceId, 'all', ''),
    ...(teamId === '' ? [] : [dashboardsKey(workspaceId, 'all', teamId)]),
    ...(dashboardId === undefined
      ? []
      : [dashboardKey(workspaceId, dashboardId)]),
  ]);
};
