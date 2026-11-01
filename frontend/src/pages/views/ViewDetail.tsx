/**
 * One saved view, opened as the list or board its stored filters and display
 * describe. The view's own settings are the page's base, so changes made here
 * live in the URL until they are saved over the view or as a new one, and a
 * link to the view always opens it as it was saved. A view of projects opens
 * as the projects page, on the same terms.
 */

import React, { useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { Link, useParams } from 'react-router-dom';
import {
  getView,
  listsProjects,
  updateView,
  type SavedViewDisplayRead,
} from '../../api/views';
import type { InsightsDefaultControl } from '../../components/issues/view/InsightsPanel';
import IssueViewPage, {
  refreshViewLists,
} from '../../components/issues/view/IssueViewPage';
import { ErrorAlert } from '../../components/ui/alert';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import {
  useInsightsPlacement,
  type InsightsPlacement,
} from '../../hooks/useInsightsPlacement';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canEditSharedView, canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { viewScope, viewToState } from '../../lib/issueView';
import { viewsPath } from '../../lib/paths';
import { viewKey } from '../../lib/queryKeys';
import Projects from '../planning/Projects';
import type { InsightsDisplay, TeamRead } from '../../types/Api';

/** How often the view is re-read. */
const POLL_MS = 60000;

/** Props for SavedView. */
interface SavedViewProps {
  view: SavedViewDisplayRead;
  teams: TeamRead[];
  workspaceId: string;
  slug: string;
  leading: React.ReactNode;
  /** Re-reads the view, settling once the page holds the saved version. */
  refetchView: () => Promise<unknown>;
  insightsPlacement: InsightsPlacement;
}

/** One loaded version of a view, remounted whenever the view is saved. */
const SavedView: React.FC<SavedViewProps> = ({
  view,
  teams,
  workspaceId,
  slug,
  leading,
  refetchView,
  insightsPlacement,
}) => {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const [base] = useState(() => viewToState(view));
  const [scope] = useState(() => viewScope(view.filter));
  const teamId = typeof scope.team_id === 'string' ? scope.team_id : '';
  const viewTeams = useMemo(
    () => (teamId === '' ? teams : teams.filter((team) => team.id === teamId)),
    [teams, teamId]
  );
  const homeTeam = viewTeams.length === 1 ? viewTeams[0] : undefined;
  const canEdit = viewTeams.some((team) =>
    canWriteIssues(workspace?.role, team.role)
  );

  const mayEditDefault = canEditSharedView(
    view,
    user?.id,
    workspace?.role,
    teams.find((team) => team.id === view.team_id)?.role
  );
  const insightsDefault: InsightsDefaultControl = {
    display: view.insights_display ?? null,
    save: mayEditDefault
      ? async (display: InsightsDisplay | null) => {
          await updateView(workspaceId, view.view_id, {
            insights_display: display,
          });
          refreshViewLists(workspaceId, view.team_id ?? undefined);
          await refetchView();
        }
      : undefined,
  };

  return (
    <IssueViewPage
      workspaceId={workspaceId}
      slug={slug}
      title={view.name}
      leading={leading}
      scopeKey={`view:${view.view_id}:${view.updated_at}`}
      insightsScopeKey={`view:${view.view_id}`}
      insightsDefault={insightsDefault}
      insightsPlacement={insightsPlacement}
      scope={scope}
      teams={viewTeams}
      base={base}
      view={view}
      canEdit={canEdit}
      homeTeam={homeTeam}
      emptyMessage="No issues match this view."
    />
  );
};

/**
 * One open view across its saved versions, holding what must outlast the remount
 * each save brings, so setting a default from the insights panel leaves it open.
 */
const SavedViewHost: React.FC<Omit<SavedViewProps, 'insightsPlacement'>> = (
  props
) => {
  const insightsPlacement = useInsightsPlacement();
  return (
    <SavedView
      key={props.view.updated_at}
      {...props}
      insightsPlacement={insightsPlacement}
    />
  );
};

/** A saved view's issues. */
export const ViewDetail: React.FC = () => {
  const { viewId = '' } = useParams<{ viewId: string }>();
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const auth = useQueryAuth();
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';

  const {
    data: view,
    error,
    refetch: refetchView,
  } = usePolledQuery(
    ({ signal }) => getView(workspaceId, viewId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && viewId !== '',
      queryKey: viewKey(workspaceId, viewId),
      auth,
    }
  );

  const leading = (
    <Link
      to={viewsPath(slug)}
      className="text-sm text-text-muted hover:text-text"
    >
      Views
    </Link>
  );

  if (view === null || teams.length === 0) {
    return (
      <WorkspaceShell title="View" leading={leading} flush>
        {error !== null ? (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={errorMessage(error, 'Could not load the view.')}
            />
          </div>
        ) : (
          <SkeletonRows label="Loading view" />
        )}
      </WorkspaceShell>
    );
  }

  if (listsProjects(view)) {
    return (
      <Projects
        key={`${view.view_id}:${view.updated_at}`}
        view={view}
        leading={leading}
      />
    );
  }

  return (
    <SavedViewHost
      key={view.view_id}
      view={view}
      teams={teams}
      workspaceId={workspaceId}
      slug={slug}
      leading={leading}
      refetchView={refetchView}
    />
  );
};

export default ViewDetail;
