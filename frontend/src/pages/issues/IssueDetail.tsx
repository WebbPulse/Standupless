/**
 * One issue, resolved from the `:key` in the route through the by-key read,
 * which is the address a person can type from memory. The supporting lists are
 * read once here and handed down, so each section does not read them again.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuChevronRight } from 'react-icons/lu';
import { Link, useParams } from 'react-router-dom';
import { getIssueByKey, listIssues } from '../../api/issues';
import {
  listLabels,
  listTeamMembers,
  listTeams,
  listStatuses,
} from '../../api/teams';
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
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import ShareButton from '../../components/access/ShareButton';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { useAuth } from '../../hooks/useAuth';
import {
  issueKey,
  labelsKey,
  parentsKey,
  teamMembersKey,
  teamsKey,
  statusesKey,
} from '../../lib/queryKeys';
import { teamPath } from '../../lib/paths';
import type { IssueRead } from '../../types/Api';

/** How often the issue and its supporting lists are re-read. */
const POLL_MS = 60000;

/** How many candidate parents the parent picker offers. */
const PARENT_LIMIT = 100;

/** The team link in the page bar, in the shared link colour. */
const TEAM_LINK_CLASS = `${LINK_CLASS} truncate font-normal`;

/** The full view of one issue, with its sub-issues, links and activity. */
export const IssueDetail: React.FC = () => {
  const { slug, key } = useParams<{ slug: string; key: string }>();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const auth = useQueryAuth();
  const [saved, setSaved] = useState<IssueRead | null>(null);

  const workspaceId = workspace?.id ?? '';
  const issueRef = key ?? '';
  const authOption = { auth };
  const enabled = workspaceId !== '' && issueRef !== '';

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getIssueByKey(workspaceId, issueRef, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: issueKey(workspaceId, issueRef),
      ...authOption,
    }
  );

  const issue =
    saved !== null && data !== null && saved.id === data.id
      ? saved.updated_at >= data.updated_at
        ? saved
        : data
      : data;

  const teamId = issue?.team_id ?? '';
  const hasTeam = teamId !== '';

  const { data: teams } = usePolledQuery(
    ({ signal }) => listTeams(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: teamsKey(workspaceId),
      ...authOption,
    }
  );

  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasTeam,
      queryKey: statusesKey(teamId),
      ...authOption,
    }
  );

  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasTeam,
      queryKey: labelsKey(teamId),
      ...authOption,
    }
  );

  const { data: people } = usePolledQuery(
    ({ signal }) => listTeamMembers(workspaceId, teamId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasTeam,
      queryKey: teamMembersKey(teamId),
      ...authOption,
    }
  );

  const { data: siblings } = usePolledQuery(
    ({ signal }) =>
      listIssues(
        workspaceId,
        { team_id: teamId, sort: 'key_asc', limit: PARENT_LIMIT },
        signal
      ),
    {
      intervalMs: POLL_MS,
      enabled: hasTeam,
      queryKey: parentsKey(teamId),
      ...authOption,
    }
  );

  const team = teams?.find((item) => item.id === teamId);
  const canEdit = canWriteIssues(workspace?.role, team?.role);
  const isAdmin = isTeamAdmin(workspace?.role, team?.role);
  const currentUserId = user?.id ?? '';

  const parents = (siblings?.issues ?? []).filter(
    (candidate) =>
      candidate.id !== issue?.id && candidate.parent_id !== issue?.id
  );

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
      <div className="min-h-0 flex-1 overflow-y-auto">
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
          <div className="flex min-h-full flex-col-reverse lg:flex-row">
            <div className="min-w-0 flex-1 px-4 py-6 lg:px-6">
              <div className="max-w-3xl space-y-8">
                <IssueBody
                  workspaceId={workspaceId}
                  issue={issue}
                  canEdit={canEdit}
                  onSaved={setSaved}
                />

                <SubIssues
                  workspaceId={workspaceId}
                  issueId={issue.id}
                  slug={slug ?? ''}
                  progress={issue.progress}
                  statuses={statuses ?? []}
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

                  <CommentThread
                    workspaceId={workspaceId}
                    issueId={issue.id}
                    currentUserId={currentUserId}
                    canComment={canEdit}
                    isAdmin={isAdmin}
                  />

                  <ActivityFeed
                    workspaceId={workspaceId}
                    issueId={issue.id}
                    people={people ?? []}
                  />
                </div>
              </div>
            </div>

            <aside
              aria-label="Properties"
              className="w-full shrink-0 border-b border-line bg-surface px-4 py-4 lg:w-rail lg:border-b-0 lg:border-l lg:px-4"
            >
              <div className="space-y-5">
                {team !== undefined && (
                  <IssueFields
                    workspaceId={workspaceId}
                    issue={issue}
                    estimateScale={team.estimate_scale}
                    statuses={statuses ?? []}
                    labels={labels ?? []}
                    people={people ?? []}
                    parents={parents}
                    canEdit={canEdit}
                    onSaved={setSaved}
                  />
                )}

                {team !== undefined && (
                  <PlanningPickers
                    workspaceId={workspaceId}
                    teamId={teamId}
                    issue={issue}
                    canEdit={canEdit}
                    onSaved={setSaved}
                  />
                )}

                <p className="text-xs text-text-faint">
                  Last updated {timestampLabel(issue.updated_at)}
                </p>
              </div>
            </aside>
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default IssueDetail;
