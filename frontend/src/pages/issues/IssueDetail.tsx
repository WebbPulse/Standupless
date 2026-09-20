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
  listProjectMembers,
  listProjects,
  listStatuses,
} from '../../api/projects';
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
import { canWriteIssues, isProjectAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { useAuth } from '../../hooks/useAuth';
import {
  issueKey,
  labelsKey,
  parentsKey,
  projectMembersKey,
  projectsKey,
  statusesKey,
} from '../../lib/queryKeys';
import type { IssueRead } from '../../types/Api';

/** How often the issue and its supporting lists are re-read. */
const POLL_MS = 60000;

/** How many candidate parents the parent picker offers. */
const PARENT_LIMIT = 100;

/** The project link in the page bar, in the shared link colour. */
const PROJECT_LINK_CLASS = `${LINK_CLASS} truncate font-normal`;

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

  const projectId = issue?.project_id ?? '';
  const hasProject = projectId !== '';

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: projectsKey(workspaceId),
      ...authOption,
    }
  );

  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasProject,
      queryKey: statusesKey(projectId),
      ...authOption,
    }
  );

  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasProject,
      queryKey: labelsKey(projectId),
      ...authOption,
    }
  );

  const { data: people } = usePolledQuery(
    ({ signal }) => listProjectMembers(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasProject,
      queryKey: projectMembersKey(projectId),
      ...authOption,
    }
  );

  const { data: siblings } = usePolledQuery(
    ({ signal }) =>
      listIssues(
        workspaceId,
        { project_id: projectId, sort: 'key_asc', limit: PARENT_LIMIT },
        signal
      ),
    {
      intervalMs: POLL_MS,
      enabled: hasProject,
      queryKey: parentsKey(projectId),
      ...authOption,
    }
  );

  const project = projects?.find((item) => item.id === projectId);
  const canEdit = canWriteIssues(workspace?.role, project?.role);
  const isAdmin = isProjectAdmin(workspace?.role, project?.role);
  const currentUserId = user?.id ?? '';

  const parents = (siblings?.issues ?? []).filter(
    (candidate) =>
      candidate.id !== issue?.id && candidate.parent_id !== issue?.id
  );

  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      {project !== undefined && (
        <>
          <Link
            to={`/w/${slug ?? ''}/p/${project.key_prefix}`}
            className={PROJECT_LINK_CLASS}
          >
            {project.name}
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
                {project !== undefined && (
                  <IssueFields
                    workspaceId={workspaceId}
                    issue={issue}
                    estimateScale={project.estimate_scale}
                    statuses={statuses ?? []}
                    labels={labels ?? []}
                    people={people ?? []}
                    parents={parents}
                    canEdit={canEdit}
                    onSaved={setSaved}
                  />
                )}

                {project !== undefined && (
                  <PlanningPickers
                    workspaceId={workspaceId}
                    projectId={projectId}
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
