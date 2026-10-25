/**
 * The dashboard routes: pages of insight widgets over several teams and saved
 * views. Each widget's figures are read by their own route, which applies the
 * widget's filter and the dashboard's together with the caller's visibility,
 * so a dashboard never shows a team its reader cannot see.
 */

import apiClient from './client';
import { normalizeInsights } from './insights';
import type {
  DashboardCreate,
  DashboardRead,
  DashboardScope,
  DashboardUpdate,
  DashboardWidgetCreate,
  InsightsRead,
} from '../types/Api';

/** Which dashboards a list asks for. */
export type DashboardListScope = 'all' | DashboardScope;

/** The dashboards collection, under the views prefix the gateway already routes. */
export const dashboardsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/views/dashboards`;

/** One dashboard. */
export const dashboardPath = (
  workspaceId: string,
  dashboardId: string
): string => `/workspaces/${workspaceId}/views/dashboards/${dashboardId}`;

/** The route that refiles a dashboard as personal, a team's or the workspace's. */
export const dashboardMovePath = (
  workspaceId: string,
  dashboardId: string
): string => `/workspaces/${workspaceId}/views/dashboards/${dashboardId}/move`;

/** A dashboard's widgets, where a new one is added at the end. */
export const dashboardWidgetsPath = (
  workspaceId: string,
  dashboardId: string
): string =>
  `/workspaces/${workspaceId}/views/dashboards/${dashboardId}/widgets`;

/** The order a dashboard draws its widgets in. */
export const dashboardWidgetOrderPath = (
  workspaceId: string,
  dashboardId: string
): string =>
  `/workspaces/${workspaceId}/views/dashboards/${dashboardId}/widgets/order`;

/** One widget of a dashboard. */
export const dashboardWidgetPath = (
  workspaceId: string,
  dashboardId: string,
  widgetId: string
): string =>
  `/workspaces/${workspaceId}/views/dashboards/${dashboardId}/widgets/${widgetId}`;

/** One widget's breakdown. */
export const dashboardWidgetInsightsPath = (
  workspaceId: string,
  dashboardId: string,
  widgetId: string
): string =>
  `/workspaces/${workspaceId}/views/dashboards/${dashboardId}/widgets/${widgetId}/insights`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists the dashboards the caller may read, personal ones first. */
export const listDashboards = async (
  workspaceId: string,
  query: { scope?: DashboardListScope; team_id?: string } = {},
  signal?: AbortSignal
): Promise<DashboardRead[]> => {
  const response = await apiClient.get<{ dashboards: DashboardRead[] }>(
    dashboardsPath(workspaceId),
    signal === undefined
      ? { query: { ...query } }
      : { query: { ...query }, signal }
  );
  return Array.isArray(response.data?.dashboards)
    ? response.data.dashboards
    : [];
};

/** Reads one dashboard. */
export const getDashboard = async (
  workspaceId: string,
  dashboardId: string,
  signal?: AbortSignal
): Promise<DashboardRead> => {
  const response = await apiClient.get<DashboardRead>(
    dashboardPath(workspaceId, dashboardId),
    signalOptions(signal)
  );
  return response.data;
};

/** Creates a dashboard owned by the caller. */
export const createDashboard = async (
  workspaceId: string,
  body: DashboardCreate
): Promise<DashboardRead> => {
  const response = await apiClient.post<DashboardRead>(
    dashboardsPath(workspaceId),
    body
  );
  return response.data;
};

/** Changes a dashboard's name, description, shared filter or owner. */
export const updateDashboard = async (
  workspaceId: string,
  dashboardId: string,
  body: DashboardUpdate
): Promise<DashboardRead> => {
  const response = await apiClient.patch<DashboardRead>(
    dashboardPath(workspaceId, dashboardId),
    body
  );
  return response.data;
};

/** Deletes a dashboard for everyone who can see it. */
export const deleteDashboard = async (
  workspaceId: string,
  dashboardId: string
): Promise<void> => {
  await apiClient.delete<void>(dashboardPath(workspaceId, dashboardId));
};

/** Refiles a dashboard as personal, under a team, or for the workspace. */
export const moveDashboard = async (
  workspaceId: string,
  dashboardId: string,
  body: { scope: DashboardScope; team_id?: string | null }
): Promise<DashboardRead> => {
  const response = await apiClient.post<DashboardRead>(
    dashboardMovePath(workspaceId, dashboardId),
    body
  );
  return response.data;
};

/** Adds a widget at the end of a dashboard. */
export const addDashboardWidget = async (
  workspaceId: string,
  dashboardId: string,
  body: DashboardWidgetCreate
): Promise<DashboardRead> => {
  const response = await apiClient.post<DashboardRead>(
    dashboardWidgetsPath(workspaceId, dashboardId),
    body
  );
  return response.data;
};

/** Changes one widget. */
export const updateDashboardWidget = async (
  workspaceId: string,
  dashboardId: string,
  widgetId: string,
  body: DashboardWidgetCreate
): Promise<DashboardRead> => {
  const response = await apiClient.patch<DashboardRead>(
    dashboardWidgetPath(workspaceId, dashboardId, widgetId),
    body
  );
  return response.data;
};

/** Removes one widget. */
export const deleteDashboardWidget = async (
  workspaceId: string,
  dashboardId: string,
  widgetId: string
): Promise<DashboardRead> => {
  const response = await apiClient.delete<DashboardRead>(
    dashboardWidgetPath(workspaceId, dashboardId, widgetId)
  );
  return response.data;
};

/** Sets the order every widget is drawn in. */
export const reorderDashboardWidgets = async (
  workspaceId: string,
  dashboardId: string,
  widgetIds: string[]
): Promise<DashboardRead> => {
  const response = await apiClient.put<DashboardRead>(
    dashboardWidgetOrderPath(workspaceId, dashboardId),
    { widget_ids: widgetIds }
  );
  return response.data;
};

/** Reads one widget's breakdown. */
export const getWidgetInsights = async (
  workspaceId: string,
  dashboardId: string,
  widgetId: string,
  signal?: AbortSignal
): Promise<InsightsRead> => {
  const response = await apiClient.get<InsightsRead>(
    dashboardWidgetInsightsPath(workspaceId, dashboardId, widgetId),
    signalOptions(signal)
  );
  return normalizeInsights(response.data, 'status');
};
