/**
 * One issue, resolved from the `:key` in the route through the by-key read,
 * which is the address a person can type from memory. The supporting lists are
 * read once here and handed down, so each section does not read them again.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuChevronRight } from 'react-icons/lu';
import { Link, useParams } from 'react-router-dom';
import { getIssueByKey, updateIssue } from '../../api/issues';
import { listTeams } from '../../api/teams';
import AttachmentsSection from '../../components/discussion/AttachmentsSection';
import CommentThread from '../../components/discussion/CommentThread';
import ReactionBar from '../../components/discussion/ReactionBar';
import ActivityFeed from '../../components/issues/ActivityFeed';
import IssueBody from '../../components/issues/IssueBody';
import IssueFields from '../../components/issues/IssueFields';
import GithubLinksSection from '../../components/issues/GithubLinksSection';
import LinksSection from '../../components/issues/LinksSection';
import PlanningPickers from '../../components/issues/PlanningPickers';
import SubIssues from '../../components/issues/SubIssues';
import { ErrorAlert } from '../../components/ui/alert';
import { LINK_CLASS } from '../../components/ui/link';
import Spinner from '../../components/ui/spinner';
import { Toaster } from '../../components/ui/toast';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { useWorkspace } from '../../hooks/useWorkspace';
import ShareButton from '../../components/access/ShareButton';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { useOptimisticRecord } from '../../lib/optimistic';
import { useAuth } from '../../hooks/useAuth';
import { activityKey, issueKey, teamsKey } from '../../lib/queryKeys';
import { teamPath } from '../../lib/paths';
import type { IssueRead, IssueUpdate } from '../../types/Api';

/** How often the issue and its supporting lists are re-read. */
const POLL_MS = 60000;

/** The team link in the page bar, in the shared link colour. */
const TEAM_LINK_CLASS = `${LINK_CLASS} truncate font-normal`;

/** The full view of one issue, with its sub-issues, links and activity. */
export const IssueDetail: React.FC = () => {
  const { slug, key } = useParams<{ slug: string; key: string }>();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const auth = useQueryAuth();

  const workspaceId = workspace?.id ?? '';
  const issueRef = key ?? '';
  const enabled = workspaceId !== '' && issueRef !== '';

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getIssueByKey(workspaceId, issueRef, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: issueKey(workspaceId, issueRef),
      auth,
    }
  );

  const issueId = data?.id ?? '';
  const {
    value: issue,
    update,
    receive,
  } = useOptimisticRecord<IssueRead, IssueUpdate>(data, {
    write: (patch) => updateIssue(workspaceId, issueId, patch),
    invalidate: [activityKey(issueId)],
  });

  const teamId = issue?.team_id ?? '';

  const { data: teams } = usePolledQuery(
    ({ signal }) => listTeams(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: teamsKey(workspaceId),
      auth,
    }
  );

  const options = useTeamOptions(workspaceId, teamId, { parents: true });

  const team = teams?.find((item) => item.id === teamId);
  const canEdit = canWriteIssues(workspace?.role, team?.role);
  const isAdmin = isTeamAdmin(workspace?.role, team?.role);
  const currentUserId = user?.id ?? '';

  const parents = options.parents.filter(
    (candidate) =>
      candidate.id !== issue?.id && candidate.parent_id !== issue?.id
  );

  const onUpdate = (patch: IssueUpdate): void => {
    void update(patch);
  };

  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      {team !== undefined && (
        <>
          <Link
            to={teamPath(slug ?? '', team.key_prefix)}
            className={TEAM_LINK_CLASS}
          >
            {team.name}
          </Link>
          <LuChevronRight
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-text-faint"
          />
        </>
      )}
      <span className="font-mono text-text-muted">{issueRef}</span>
    </span>
  );

  return (
    <WorkspaceShell
      flush
      title={title}
      actions={
        canEdit && issue !== null ? (
          <ShareButton
            workspaceId={workspaceId}
            targetType="issue"
            targetId={issue.id}
          />
        ) : undefined
      }
    >
      <Toaster />
      {error !== null && (
        <div className="px-4 pt-4 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not load this issue.')}
          />
        </div>
      )}

      {isLoading || issue === null ? (
        error !== null ? null : (
          <div className="px-4 py-4 lg:px-6">
            <Spinner label="Loading issue" />
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          <div className="order-2 min-w-0 flex-1 lg:order-1 lg:overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-8 lg:px-12 lg:py-10">
              <IssueBody
                workspaceId={workspaceId}
                issue={issue}
                canEdit={canEdit}
                onSaved={receive}
              />

              <SubIssues
                workspaceId={workspaceId}
                issueId={issue.id}
                slug={slug ?? ''}
                progress={issue.progress}
                statuses={options.statuses}
              />

              <LinksSection
                workspaceId={workspaceId}
                issueId={issue.id}
                canEdit={canEdit}
              />

              <GithubLinksSection
                workspaceId={workspaceId}
                issueId={issue.id}
              />

              <AttachmentsSection
                workspaceId={workspaceId}
                issueId={issue.id}
                currentUserId={currentUserId}
                canAttach={canEdit}
                isAdmin={isAdmin}
              />

              <div className="space-y-8 border-t border-line pt-8">
                <ReactionBar
                  workspaceId={workspaceId}
                  targetId={issue.id}
                  targetKind="issue"
                  canReact={canEdit}
                />

                <ActivityFeed
                  workspaceId={workspaceId}
                  issueId={issue.id}
                  people={options.people}
                />

                <CommentThread
                  workspaceId={workspaceId}
                  issueId={issue.id}
                  currentUserId={currentUserId}
                  canComment={canEdit}
                  isAdmin={isAdmin}
                />
              </div>
            </div>
          </div>

          <aside
            aria-label="Properties"
            className="order-1 w-full shrink-0 border-b border-line bg-surface px-3 py-4 lg:order-2 lg:w-rail lg:overflow-y-auto lg:border-b-0 lg:border-l"
          >
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
                  currentUserId={currentUserId}
                  {...(isAdmin ? { onCreateLabel: options.createLabel } : {})}
                  onUpdate={onUpdate}
                />
              )}

              {team !== undefined && (
                <PlanningPickers
                  workspaceId={workspaceId}
                  teamId={teamId}
                  issue={issue}
                  canEdit={canEdit}
                  onUpdate={onUpdate}
                />
              )}

              <p className="px-0 text-xs text-text-faint">
                Last updated {timestampLabel(issue.updated_at)}
              </p>
            </div>
          </aside>
        </div>
      )}
    </WorkspaceShell>
  );
};

export default IssueDetail;
