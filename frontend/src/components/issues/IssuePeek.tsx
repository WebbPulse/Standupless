/**
 * A compact pane that shows one issue beside a list or board without leaving
 * it. Triage is mostly a run of small changes across many issues, and opening
 * each one as a page loses the place in the list every time. The pane carries
 * the same pickers as the detail rail, applied optimistically, and the same
 * activity and comment feed as the page, newest last, with a comment box at
 * its foot, so a thread can be read and answered without leaving the list.
 * Cmd or Ctrl+Shift+P sets the peeked issue's parent from the keyboard, and
 * Cmd or Ctrl+Shift+Up and Down peek its parent and its first sub-issue in
 * place, and O then G opens its linked pull request.
 *
 * As in Linear, a sub-issue shows its parent on a line above the title, and a
 * parent lists its sub-issues under the description with the same section the
 * page uses, read under the same key so both stay in step. A plain click on
 * either peeks that issue in place, and Cmd or Ctrl+click opens its page.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { LuMaximize2, LuX } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { IssueHoverTrigger } from '../ui/IssueHoverCard';
import { StatusIcon } from '../ui/StatusIcon';
import { getIssue, updateIssue } from '../../api/issues';
import { useAuth } from '../../hooks/useAuth';
import { useIssueChildren } from '../../hooks/useIssueChildren';
import { isTypingTarget } from '../../hooks/useCommandPalette';
import {
  useIssueTreeKeys,
  type IssueTreeTarget,
} from '../../hooks/useIssueTreeKeys';
import { useOpenPullRequestShortcut } from '../../hooks/useOpenPullRequestShortcut';
import { useQuoteRequest } from '../../hooks/useQuoteRequest';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { ActivityContext } from '../../lib/activityDisplay';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { useWritable } from '../../hooks/useOffline';
import { errorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { recordPatch } from '../../lib/issueUndo';
import { useRecordRecentIssue } from '../../lib/recentIssues';
import { useOptimisticRecord } from '../../lib/optimistic';
import { projectPatch } from '../../lib/milestones';
import { issuePath, projectMilestonePath, projectPath } from '../../lib/paths';
import { activityKey, issueKey } from '../../lib/queryKeys';
import { fullTimestamp } from '../../lib/relativeTime';
import { enteredStatusAt, timeInStatusSentence } from '../../lib/timeInStatus';
import { TRIAGE_STATUS } from '../../lib/triageStatus';
import type { IssueRead, IssueUpdate, StatusRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { IconButton } from '../ui/button';
import { PresenceAvatars } from '../ui/PresenceAvatars';
import Spinner from '../ui/spinner';
import { Toaster } from '../ui/toast';
import { RelationMarkers } from './BlockedMarker';
import PassageThreadsProvider from '../../contexts/PassageThreadsProvider';
import IssueBody from './IssueBody';
import IssueFields, { PropertyRow, PropertySection } from './IssueFields';
import IssueTimeline from './IssueTimeline';
import { IssueMilestonePicker } from './PlanningPickers';
import PlanningRowLink from './PlanningRowLink';
import SetParentDialog, { SET_PARENT_KEYS } from './SetParentDialog';
import SubIssues from './SubIssues';
import { CyclePicker, ProjectPicker } from './PropertyPickers';
import { useTeams } from '../../hooks/useTeams';
import { estimateOptionsOf } from '../../lib/validation';

/** Props for IssuePeek: which issue to show and how to dismiss the pane. */
export interface IssuePeekProps {
  issueId: string;
  onClose: () => void;
  /** Shows another issue in the pane in place of this one. */
  onOpenIssue?: (issue: IssueTreeTarget) => void;
}

/** How often the issue and its lists are re-read while the pane is open. */
const POLL_MS = 60000;

/** True for a click that should follow a link rather than peek in place. */
const opensPage = (event: React.MouseEvent): boolean =>
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey;

/**
 * The parent of a sub-issue, as a line above its title. The parent is found
 * among the team's candidate parents the pane already holds, and read on its
 * own under the issue key only when it is not one of them.
 */
const PeekParentLine: React.FC<{
  workspaceId: string;
  slug: string;
  parentId: string;
  known: readonly IssueRead[];
  statuses: StatusRead[];
  onOpenIssue?: (issue: IssueTreeTarget) => void;
}> = ({ workspaceId, slug, parentId, known, statuses, onOpenIssue }) => {
  const auth = useQueryAuth();
  const held = known.find((candidate) => candidate.id === parentId);
  const { data: fetched } = usePolledQuery(
    (context) => getIssue(workspaceId, parentId, context),
    {
      intervalMs: POLL_MS,
      enabled: held === undefined && workspaceId !== '',
      queryKey: issueKey(workspaceId, parentId),
      auth,
    }
  );
  const parent =
    held ?? (fetched !== null && fetched.id === parentId ? fetched : undefined);
  if (parent === undefined) return null;
  const status =
    parent.in_triage === true
      ? TRIAGE_STATUS
      : statuses.find((item) => item.id === parent.status_id);
  return (
    <IssueHoverTrigger issueKey={parent.key}>
      {(hover) => (
        <Link
          to={issuePath(slug, parent.key)}
          {...hover}
          aria-label={`Sub-issue of ${parent.key} ${parent.title}`}
          onClick={(event) => {
            if (onOpenIssue === undefined || opensPage(event)) return;
            event.preventDefault();
            onOpenIssue({ id: parent.id, key: parent.key });
          }}
          className="-mx-1 -mb-3 flex h-6 w-fit max-w-full items-center gap-1.5 rounded-sm px-1 text-xs text-text-muted transition-colors duration-100 hover:bg-raised hover:text-text"
        >
          <StatusIcon
            status={status}
            statuses={statuses}
            {...(status === undefined ? {} : { name: status.name })}
          />
          <span className="shrink-0 font-mono text-text-faint">
            {parent.key}
          </span>
          <span className="min-w-0 truncate">{parent.title}</span>
        </Link>
      )}
    </IssueHoverTrigger>
  );
};

/** The side pane showing one issue's title, properties and description. */
export const IssuePeek: React.FC<IssuePeekProps> = ({
  issueId,
  onClose,
  onOpenIssue,
}) => {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const auth = useQueryAuth();
  const workspaceId = workspace?.id ?? '';
  const [editingBody, setEditingBody] = useState(false);
  const enabled = workspaceId !== '' && issueId !== '';

  const { data, error, isLoading } = usePolledQuery(
    (context) => getIssue(workspaceId, issueId, context),
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
  useRecordRecentIssue(workspaceId, user?.id, issueId, issue, error);

  const { data: teams } = useTeams();

  const teamId = issue?.team_id ?? '';
  const options = useTeamOptions(workspaceId, teamId, {
    planning: true,
    parents: true,
  });
  const team = teams?.find((item) => item.id === teamId);
  const projectRef = options.projects.find(
    (row) => row.project_id === issue?.project_id
  );
  const peekStatusName =
    issue === null
      ? undefined
      : issue.in_triage === true
        ? TRIAGE_STATUS.name
        : options.statuses.find((item) => item.id === issue.status_id)?.name;
  const canEdit = useWritable(canWriteIssues(workspace?.role, team?.role));
  const isAdmin = isTeamAdmin(workspace?.role, team?.role);
  const parents = options.parents.filter(
    (candidate) =>
      candidate.id !== issue?.id && candidate.parent_id !== issue?.id
  );

  const context = useMemo<ActivityContext>(
    () => ({
      statuses: options.statuses,
      people: options.people,
      labels: options.labels.map((label) => ({
        id: label.id,
        name: label.name,
      })),
      issues: options.parents.map((row) => ({ id: row.id, key: row.key })),
      projects: options.projects.map((project) => ({
        id: project.project_id,
        name: project.name,
      })),
      cycles: options.cycles.map((cycle) => ({
        id: cycle.cycle_id,
        name: cycle.name,
      })),
    }),
    [
      options.statuses,
      options.people,
      options.labels,
      options.parents,
      options.projects,
      options.cycles,
    ]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"]') != null) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const onUpdate = (patch: IssueUpdate): void => {
    const before = issue;
    void update(patch).then((saved) => {
      if (!saved || before === null) return;
      recordPatch(workspaceId, before, patch, {
        invalidate: [issueKey(workspaceId, issueId)],
        onReverted: ([written]) => {
          if (written !== undefined) receive(written);
        },
      });
    });
  };

  const children = useIssueChildren(
    workspaceId,
    issueId,
    (issue?.progress.total ?? 0) > 0
  );
  const showSubIssues =
    issue !== null &&
    (canEdit || children.rows.length > 0 || issue.progress.total > 0);

  useIssueTreeKeys({
    workspaceId,
    issue,
    statuses: options.statuses,
    known: options.parents,
    subIssues: children.rows,
    ...(onOpenIssue === undefined ? {} : { onOpen: onOpenIssue }),
  });

  const [parenting, setParenting] = useState(false);
  const descriptionQuotes = useQuoteRequest(issueId);
  const canParent = canEdit && issue !== null;
  useShortcut({
    keys: SET_PARENT_KEYS,
    label: 'Set parent issue…',
    scope: 'issue',
    enabled: canParent,
    handler: (event) => {
      event?.preventDefault();
      setParenting(true);
    },
  });
  useShortcut({
    keys: '',
    label: 'Remove parent',
    scope: 'issue',
    enabled: canEdit && issue !== null && issue.parent_id !== null,
    handler: () => {
      onUpdate({ parent_id: null });
    },
  });
  useOpenPullRequestShortcut(workspaceId, issueId, issue !== null);

  return (
    <aside
      aria-label={issue === null ? 'Issue' : `Issue ${issue.key}`}
      className="flex h-full w-full flex-col border-l border-line bg-surface sm:w-[26rem]"
    >
      <Toaster />
      {parenting && issue !== null && (
        <SetParentDialog
          issues={[issue]}
          onPick={(parentId) => {
            onUpdate({ parent_id: parentId });
          }}
          onClose={() => {
            setParenting(false);
          }}
        />
      )}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-xs text-text-muted">
            {issue?.key ?? ''}
          </span>
          {issue !== null && <RelationMarkers issue={issue} />}
        </span>
        <div className="flex items-center gap-1">
          {issue !== null && (
            <PresenceAvatars
              workspaceId={workspaceId}
              kind="issue"
              id={issue.id}
              editing={editingBody}
              className="mr-1"
            />
          )}
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
          <PassageThreadsProvider key={issue.id}>
            <div className="space-y-5 px-4 py-4">
              {issue.parent_id !== null && workspace !== null && (
                <PeekParentLine
                  workspaceId={workspaceId}
                  slug={workspace.slug}
                  parentId={issue.parent_id}
                  known={options.parents}
                  statuses={options.statuses}
                  {...(onOpenIssue === undefined ? {} : { onOpenIssue })}
                />
              )}
              <IssueBody
                key={issue.id}
                workspaceId={workspaceId}
                issue={issue}
                canEdit={canEdit}
                onSaved={receive}
                people={options.people}
                canComment={canEdit}
                onEditingChange={setEditingBody}
                {...(canEdit ? { onQuote: descriptionQuotes.ask } : {})}
              />

              {showSubIssues && (
                <SubIssues
                  workspaceId={workspaceId}
                  slug={workspace?.slug ?? ''}
                  parent={issue}
                  rows={children.rows}
                  isLoading={children.isLoading && issue.progress.total > 0}
                  error={children.error}
                  progress={issue.progress}
                  statuses={options.statuses}
                  people={options.people}
                  canEdit={canEdit}
                  emptyHint={false}
                  {...(user?.id === undefined
                    ? {}
                    : { currentUserId: user.id })}
                  {...(onOpenIssue === undefined
                    ? {}
                    : { onOpenRow: onOpenIssue })}
                />
              )}

              <div className="space-y-3">
                {team !== undefined && (
                  <IssueFields
                    issue={issue}
                    estimateScale={team.estimate_scale}
                    estimateOptions={estimateOptionsOf(team)}
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
                      <PlanningRowLink
                        to={
                          issue.project_id === null || workspace === null
                            ? null
                            : projectPath(
                                workspace.slug,
                                projectRef ?? issue.project_id
                              )
                        }
                        label="Open project"
                      >
                        <ProjectPicker
                          disabled={!canEdit}
                          projects={options.projects}
                          value={issue.project_id}
                          onChange={(projectId) => {
                            onUpdate(projectPatch(issue, projectId));
                          }}
                        />
                      </PlanningRowLink>
                    </PropertyRow>
                    {issue.project_id !== null && (
                      <PropertyRow label="Milestone">
                        <PlanningRowLink
                          to={
                            issue.project_milestone_id == null ||
                            workspace === null
                              ? null
                              : projectMilestonePath(
                                  workspace.slug,
                                  projectRef ?? issue.project_id,
                                  issue.project_milestone_id
                                )
                          }
                          label="Open milestone"
                        >
                          <IssueMilestonePicker
                            workspaceId={workspaceId}
                            projectId={issue.project_id}
                            value={issue.project_milestone_id ?? null}
                            disabled={!canEdit}
                            onChange={(milestoneId) => {
                              onUpdate({ project_milestone_id: milestoneId });
                            }}
                          />
                        </PlanningRowLink>
                      </PropertyRow>
                    )}
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

                {peekStatusName !== undefined && (
                  <p
                    className="text-xs text-text-faint"
                    title={fullTimestamp(enteredStatusAt(issue))}
                  >
                    {timeInStatusSentence(peekStatusName, issue)}
                  </p>
                )}
                <p className="text-xs text-text-faint">
                  Last updated {timestampLabel(issue.updated_at)}
                </p>
              </div>

              <div className="border-t border-line pt-5">
                <IssueTimeline
                  workspaceId={workspaceId}
                  issueId={issue.id}
                  currentUserId={user?.id ?? ''}
                  canComment={canEdit}
                  isAdmin={isAdmin}
                  context={context}
                  slug={workspace?.slug ?? ''}
                  teamKeyPrefix={team?.key_prefix ?? ''}
                  quote={descriptionQuotes.request}
                />
              </div>
            </div>
          </PassageThreadsProvider>
        )}
      </div>
    </aside>
  );
};

export default IssuePeek;
