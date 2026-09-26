/**
 * One saved view, opened as the issue list its stored filter describes. The
 * list route takes one value per field, while a view may store several or
 * filter on things the list route cannot (a status category, a due window),
 * so the page runs the closest query it can and says plainly which parts of
 * the view it could not apply, rather than showing a wider list as if it
 * were exact.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuInfo } from 'react-icons/lu';
import { Link, useParams } from 'react-router-dom';
import { listLabels, listStatuses } from '../../api/teams';
import { getView } from '../../api/views';
import IssueList from '../../components/issues/IssueList';
import { ErrorAlert } from '../../components/ui/alert';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/errors';
import { viewsPath } from '../../lib/paths';
import { labelsKey, statusesKey, viewKey } from '../../lib/queryKeys';
import { unsupportedParts, viewQuery } from '../../lib/viewQuery';
import type { IssueRead } from '../../types/Api';

/** How often the view and its team's lists are re-read. */
const POLL_MS = 60000;

/** A saved view's issues. */
export const ViewDetail: React.FC = () => {
  const { viewId = '' } = useParams<{ viewId: string }>();
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const auth = useQueryAuth();
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';

  const { data: view, error } = usePolledQuery(
    ({ signal }) => getView(workspaceId, viewId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && viewId !== '',
      queryKey: viewKey(workspaceId, viewId),
      auth,
    }
  );

  const query = view === null ? null : viewQuery(view);
  const teamId = query?.team_id ?? '';

  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: teamId !== '',
      queryKey: statusesKey(teamId),
      auth,
    }
  );
  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: teamId !== '',
      queryKey: labelsKey(teamId),
      auth,
    }
  );

  const teamNameFor = (issue: IssueRead): string | undefined =>
    teams.find((team) => team.id === issue.team_id)?.name;

  const notes = view === null ? [] : unsupportedParts(view);
  if (view?.kind === 'board') {
    notes.unshift('this board view is shown as a list');
  }

  return (
    <WorkspaceShell
      title={view?.name ?? 'View'}
      leading={
        <Link
          to={viewsPath(slug)}
          className="text-sm text-text-muted hover:text-text"
        >
          Views
        </Link>
      }
      flush
    >
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not load the view.')}
          />
        </div>
      )}
      {notes.length > 0 && (
        <p
          role="note"
          className="flex items-start gap-2 border-b border-line px-4 py-2 text-xs text-text-muted lg:px-6"
        >
          <LuInfo aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>Shown as closely as the list allows: {notes.join('; ')}.</span>
        </p>
      )}
      {view === null || query === null ? (
        error === null && <SkeletonRows />
      ) : (
        <IssueList
          workspaceId={workspaceId}
          slug={slug}
          query={query}
          queryKey={[
            ...viewKey(workspaceId, viewId),
            'issues',
            view.updated_at,
          ]}
          statuses={statuses ?? []}
          labels={labels ?? []}
          people={[]}
          {...(teamId === '' ? { teamNameFor } : {})}
          emptyMessage="No issues match this view."
        />
      )}
    </WorkspaceShell>
  );
};

export default ViewDetail;
