/**
 * One issue, resolved from the `:key` in the route through the by-key read,
 * which is the address a person can type from memory. The supporting lists are
 * read once here and handed down, so each section does not read them again.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
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
import SubIssues from '../../components/issues/SubIssues';
import { ErrorAlert } from '../../components/ui/alert';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
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

  return (
    <WorkspaceShell>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load this issue.')}
        />
      )}

      {isLoading || issue === null ? (
        error !== null ? null : (
          <Spinner label="Loading issue" />
        )
      ) : (
        <div className="space-y-8">
          <div className="space-y-1">
            {project !== undefined && (
              <p className="text-sm text-slate-400">
                <Link
                  to={`/w/${slug ?? ''}/p/${project.key_prefix}`}
                  className="text-sky-400 hover:text-sky-300"
                >
                  {project.name}
                </Link>
              </p>
            )}
            <p className="text-xs text-slate-500">
              Last updated {timestampLabel(issue.updated_at)}
            </p>
          </div>

          <IssueBody
            workspaceId={workspaceId}
            issue={issue}
            canEdit={canEdit}
            onSaved={setSaved}
          />

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

          <SubIssues
            workspaceId={workspaceId}
            issueId={issue.id}
            slug={slug ?? ''}
            progress={issue.progress}
            statuses={statuses ?? []}
          />

          <ReactionBar
            workspaceId={workspaceId}
            targetId={issue.id}
            targetKind="issue"
            canReact={canEdit}
          />

          <LinksSection
            workspaceId={workspaceId}
            issueId={issue.id}
            canEdit={canEdit}
          />

          <GithubLinksSection workspaceId={workspaceId} issueId={issue.id} />

          <AttachmentsSection
            workspaceId={workspaceId}
            issueId={issue.id}
            currentUserId={currentUserId}
            canAttach={canEdit}
            isAdmin={isAdmin}
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
      )}
    </WorkspaceShell>
  );
};

export default IssueDetail;
