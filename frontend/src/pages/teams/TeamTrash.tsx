/**
 * One team's recently deleted issues, the way Linear's trash lists them: who
 * deleted each one and when, a Restore that puts it back where it was, and a
 * Delete permanently for team admins. The sweep purges anything older than
 * the retention window, so the page says how long an issue stays here.
 */

import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  deleteIssuePermanently,
  listDeletedIssues,
  restoreIssue,
} from '../../api/issues';
import { ErrorAlert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import { RelativeTime } from '../../components/ui/relative-time';
import { SkeletonRows } from '../../components/ui/skeleton';
import TeamTabs from '../../components/workspace/TeamTabs';
import TeamTitle from '../../components/workspace/TeamTitle';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { errorMessage } from '../../lib/errors';
import { issuePath } from '../../lib/paths';
import { issueKey, trashKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { IssueRead, MemberRead } from '../../types/Api';

/** How often the trash is re-read, in ms. */
const POLL_MS = 60000;

/** The retention the page states until the first read answers it. */
const DEFAULT_RETENTION_DAYS = 30;

/** The name a deleter shows under, falling back when they left the workspace. */
const deleterName = (
  userId: string | null | undefined,
  people: MemberRead[]
): string => {
  const person = people.find((row) => row.user_id === userId);
  if (person === undefined) return 'Someone';
  return person.display_name ?? (person.full_name || 'Someone');
};

/** The recently deleted issues of the team named by the route's key prefix. */
const TeamTrash: React.FC = () => {
  const { keyPrefix } = useParams<{ keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const { team, workspaceId, isLoading, notFound, error } = useTeam(keyPrefix);
  const auth = useQueryAuth();
  const slug = workspace?.slug ?? '';
  const isMember = workspace !== null && workspace.role !== 'guest';
  const people = useWorkspaceMembers(workspaceId, isMember);
  const teamId = team?.id ?? '';
  const isAdmin = team?.role === 'admin';
  const queryKey = trashKey(workspaceId, teamId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [purging, setPurging] = useState<IssueRead | null>(null);

  const {
    data,
    error: listError,
    isLoading: listLoading,
  } = usePolledQuery(() => listDeletedIssues(workspaceId, teamId), {
    intervalMs: POLL_MS,
    enabled: workspaceId !== '' && teamId !== '',
    queryKey,
    auth,
  });
  const issues = data?.issues ?? [];
  const retentionDays = data?.retention_days ?? DEFAULT_RETENTION_DAYS;

  const restore = async (issue: IssueRead): Promise<void> => {
    setBusyId(issue.id);
    setActionError(null);
    try {
      await restoreIssue(workspaceId, issue.id);
      invalidateQueries([queryKey, issueKey(workspaceId, issue.id)]);
      showToast(`Restored ${issue.key}`);
    } catch (caught) {
      setActionError(errorMessage(caught, `Could not restore ${issue.key}.`));
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (issue: IssueRead): Promise<void> => {
    setBusyId(issue.id);
    setActionError(null);
    try {
      await deleteIssuePermanently(workspaceId, issue.id);
      setPurging(null);
      invalidateQueries([queryKey]);
      showToast(`Deleted ${issue.key} permanently`);
    } catch (caught) {
      setPurging(null);
      setActionError(errorMessage(caught, `Could not delete ${issue.key}.`));
    } finally {
      setBusyId(null);
    }
  };

  if (notFound || (team === null && !isLoading)) {
    return (
      <WorkspaceShell title="Recently deleted">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this team.')}
          />
        )}
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  if (team === null) {
    return (
      <WorkspaceShell title="Recently deleted">
        <SkeletonRows label="Loading deleted issues" />
      </WorkspaceShell>
    );
  }

  const canAct = team.role !== undefined;

  return (
    <WorkspaceShell
      title={<TeamTitle name={team.name} keyPrefix={team.key_prefix} />}
      toolbar={
        <TeamTabs
          slug={slug}
          keyPrefix={team.key_prefix}
          teamId={team.id}
          current="issues"
        />
      }
    >
      <div className="mx-auto max-w-3xl px-4 py-6 lg:px-8">
        <h2 className="text-base font-semibold text-text">Recently deleted</h2>
        <p className="mt-1 text-sm text-text-muted">
          Deleted issues stay here for {retentionDays} days, then they are
          deleted permanently.
        </p>
        {listError !== null && (
          <div className="mt-4">
            <ErrorAlert
              message={errorMessage(
                listError,
                'Could not load deleted issues.'
              )}
            />
          </div>
        )}
        {actionError !== null && (
          <div className="mt-4">
            <ErrorAlert message={actionError} />
          </div>
        )}
        <div className="mt-4">
          {listLoading && data === undefined ? (
            <SkeletonRows label="Loading deleted issues" />
          ) : issues.length === 0 ? (
            <EmptyState message="No deleted issues. An issue you delete shows here until it is restored or purged." />
          ) : (
            <ul
              aria-label="Deleted issues"
              className="divide-y divide-line rounded-md border border-line"
            >
              {issues.map((issue) => (
                <li
                  key={issue.id}
                  className="flex flex-wrap items-center gap-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <Link
                        to={issuePath(slug, issue.key)}
                        className="shrink-0 font-mono text-xs text-text-muted hover:text-text"
                      >
                        {issue.key}
                      </Link>
                      <span className="truncate text-sm text-text">
                        {issue.title}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-text-muted">
                      Deleted by {deleterName(issue.deleted_by, people)}
                      {issue.deleted_at !== null &&
                        issue.deleted_at !== undefined && (
                          <>
                            {' '}
                            <RelativeTime value={issue.deleted_at} />
                          </>
                        )}
                    </div>
                  </div>
                  {canAct && (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        disabled={busyId === issue.id}
                        aria-label={`Restore ${issue.key}`}
                        onClick={() => {
                          void restore(issue);
                        }}
                      >
                        Restore
                      </Button>
                      {isAdmin && (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busyId === issue.id}
                          aria-label={`Delete ${issue.key} permanently`}
                          onClick={() => {
                            setPurging(issue);
                          }}
                        >
                          Delete permanently
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <Dialog
        open={purging !== null}
        onClose={() => {
          setPurging(null);
        }}
        title="Delete permanently?"
        {...(purging === null
          ? {}
          : {
              description: `${purging.key} and its comments and history are removed for good. This cannot be undone.`,
            })}
        size="sm"
      >
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              setPurging(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={purging === null || busyId === purging.id}
            onClick={() => {
              if (purging !== null) void purge(purging);
            }}
          >
            Delete permanently
          </Button>
        </div>
      </Dialog>
    </WorkspaceShell>
  );
};

export default TeamTrash;
