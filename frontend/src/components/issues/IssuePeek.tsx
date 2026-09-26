/**
 * A compact pane that shows one issue beside a list or board without leaving
 * it. Triage is mostly a run of small changes across many issues, and opening
 * each one as a page loses the place in the list every time. The pane carries
 * the same pickers as the detail rail, applied optimistically, and links out
 * to the full page for the discussion and history it leaves out.
 */

import React, { useEffect } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuMaximize2, LuX } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { getIssue, updateIssue } from '../../api/issues';
import { listTeams } from '../../api/teams';
import { useAuth } from '../../hooks/useAuth';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { useOptimisticRecord } from '../../lib/optimistic';
import { issuePath } from '../../lib/paths';
import { activityKey, issueKey, teamsKey } from '../../lib/queryKeys';
import type { IssueRead, IssueUpdate } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { IconButton } from '../ui/button';
import Spinner from '../ui/spinner';
import { Toaster } from '../ui/toast';
import IssueBody from './IssueBody';
import IssueFields, { PropertyRow, PropertySection } from './IssueFields';
import { CyclePicker, ProjectPicker } from './PropertyPickers';

/** Props for IssuePeek: which issue to show and how to dismiss the pane. */
export interface IssuePeekProps {
  issueId: string;
  onClose: () => void;
}

/** How often the issue and its lists are re-read while the pane is open. */
const POLL_MS = 60000;

/** The side pane showing one issue's title, properties and description. */
export const IssuePeek: React.FC<IssuePeekProps> = ({ issueId, onClose }) => {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const auth = useQueryAuth();
  const workspaceId = workspace?.id ?? '';
  const enabled = workspaceId !== '' && issueId !== '';

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getIssue(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: issueKey(workspaceId, issueId),
      auth,
    }
  );

  const {
    value: issue,
    update,
    receive,
  } = useOptimisticRecord<IssueRead, IssueUpdate>(data, {
    write: (patch) => updateIssue(workspaceId, issueId, patch),
    invalidate: [activityKey(issueId)],
  });

  const { data: teams } = usePolledQuery(
    ({ signal }) => listTeams(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: teamsKey(workspaceId),
      auth,
    }
  );

  const teamId = issue?.team_id ?? '';
  const options = useTeamOptions(workspaceId, teamId, {
    planning: true,
    parents: true,
  });
  const team = teams?.find((item) => item.id === teamId);
  const canEdit = canWriteIssues(workspace?.role, team?.role);
  const isAdmin = isTeamAdmin(workspace?.role, team?.role);
  const parents = options.parents.filter(
    (candidate) =>
      candidate.id !== issue?.id && candidate.parent_id !== issue?.id
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [role="dialog"]') != null) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const onUpdate = (patch: IssueUpdate): void => {
    void update(patch);
  };

  return (
    <aside
      aria-label={issue === null ? 'Issue' : `Issue ${issue.key}`}
      className="flex h-full w-full flex-col border-l border-line bg-surface sm:w-[26rem]"
    >
      <Toaster />
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="truncate font-mono text-xs text-text-muted">
          {issue?.key ?? ''}
        </span>
        <div className="flex items-center gap-1">
          {issue !== null && workspace !== null && (
            <Link
              to={issuePath(workspace.slug, issue.key)}
              aria-label="Open full page"
              title="Open full page"
              className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-raised hover:text-text"
            >
              <LuMaximize2 aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
          )}
          <IconButton label="Close" size="sm" onClick={onClose}>
            <LuX className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error !== null && (
          <div className="p-4">
            <ErrorAlert
              message={errorMessage(error, 'Could not load this issue.')}
            />
          </div>
        )}
        {issue === null ? (
          isLoading && error === null ? (
            <div className="p-4">
              <Spinner label="Loading issue" />
            </div>
          ) : null
        ) : (
          <div className="space-y-5 px-4 py-4">
            <IssueBody
              key={issue.id}
              workspaceId={workspaceId}
              issue={issue}
              canEdit={canEdit}
              onSaved={receive}
            />

            <div className="space-y-3">
              {team !== undefined && (
                <IssueFields
                  issue={issue}
                  estimateScale={team.estimate_scale}
                  statuses={options.statuses}
                  labels={options.labels}
                  people={options.people}
                  parents={parents}
                  canEdit={canEdit}
                  {...(user?.id === undefined
                    ? {}
                    : { currentUserId: user.id })}
                  {...(isAdmin ? { onCreateLabel: options.createLabel } : {})}
                  onUpdate={onUpdate}
                />
              )}

              {team !== undefined && (
                <PropertySection title="Planning">
                  <PropertyRow label="Project">
                    <ProjectPicker
                      disabled={!canEdit}
                      projects={options.projects}
                      value={issue.project_id}
                      onChange={(projectId) => {
                        onUpdate({ project_id: projectId });
                      }}
                    />
                  </PropertyRow>
                  <PropertyRow label="Cycle">
                    <CyclePicker
                      disabled={!canEdit}
                      cycles={options.cycles}
                      value={issue.cycle_id}
                      onChange={(cycleId) => {
                        onUpdate({ cycle_id: cycleId });
                      }}
                    />
                  </PropertyRow>
                </PropertySection>
              )}

              <p className="text-xs text-text-faint">
                Last updated {timestampLabel(issue.updated_at)}
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

export default IssuePeek;
