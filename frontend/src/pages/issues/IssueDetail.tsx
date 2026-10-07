/**
 * One issue, resolved from the `:key` in the route through the by-key read,
 * which is the address a person can type from memory. The main column holds
 * the title, the description and one timeline of changes and comments; every
 * connective piece, the parent, sub-issues, relations, links and files, lives
 * in the rail as a folding section. Adding any of them opens a dialog or picker
 * from the section header, the issue menu, the command palette or a shortcut.
 * An archived issue still opens here by its key, under a banner that restores
 * it, and the same menu, palette entry and `#` key archive a live one.
 * Move to team gives the issue a new key, and an old key that still resolves
 * is replaced in the address with the current one.
 * Opened from a list, the page bar shows the issue's place in that list, and
 * j, k and Escape step through it or return to it.
 *
 * The supporting lists are read once here and handed down, so the rail and the
 * timeline resolve the same ids without reading them twice.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import type { IconType } from 'react-icons';
import {
  LuArchive,
  LuArchiveRestore,
  LuArrowLeftRight,
  LuBan,
  LuChevronRight,
  LuCopy,
  LuCopyMinus,
  LuEllipsis,
  LuLink2,
  LuListTree,
  LuOctagonAlert,
  LuTrash2,
  LuUsers,
} from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  appendIssues,
  archiveIssue,
  deleteIssue,
  getIssueByKey,
  listChildren,
  listLinks,
  unarchiveIssue,
  updateIssue,
} from '../../api/issues';
import { listCycles, listProjects } from '../../api/planning';
import ShareButton from '../../components/access/ShareButton';
import ReactionBar from '../../components/discussion/ReactionBar';
import AddLinkDialog from '../../components/issues/AddLinkDialog';
import AddRelationDialog from '../../components/issues/AddRelationDialog';
import GithubIssueSection from '../../components/issues/GithubIssueSection';
import GithubLinksSection from '../../components/issues/GithubLinksSection';
import IssueSubscribers from '../../components/issues/IssueSubscribers';
import IssueBody from '../../components/issues/IssueBody';
import IssueFields, {
  PropertySection,
} from '../../components/issues/IssueFields';
import MoveIssueDialog, {
  IssueTeamRow,
  MOVE_ISSUE_KEYS,
  MOVE_ISSUE_LABEL,
} from '../../components/issues/MoveIssueDialog';
import IssuePageCommands from '../../components/issues/IssuePageCommands';
import IssueParent from '../../components/issues/IssueParent';
import IssueRelations from '../../components/issues/IssueRelations';
import IssueResources from '../../components/issues/IssueResources';
import IssueTimeline from '../../components/issues/IssueTimeline';
import IssueTrailNav from '../../components/issues/IssueTrailNav';
import IssueMediaProvider from '../../components/media/IssueMediaProvider';
import PlanningPickers from '../../components/issues/PlanningPickers';
import SubIssues from '../../components/issues/SubIssues';
import { ErrorAlert } from '../../components/ui/alert';
import { IconButton } from '../../components/ui/button';
import { LINK_CLASS } from '../../components/ui/link';
import Menu, {
  MenuItem,
  MenuSeparator,
  MenuShortcut,
} from '../../components/ui/menu';
import {
  ARCHIVE_ISSUE_KEYS,
  DELETE_ISSUE_KEYS,
} from '../../components/issues/view/propertyKeys';
import Spinner from '../../components/ui/spinner';
import { Toaster } from '../../components/ui/toast';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAttachFiles } from '../../hooks/useAttachFiles';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { useTeams } from '../../hooks/useTeams';
import { useProjectMilestones } from '../../hooks/useProjectMilestones';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { ActivityContext } from '../../lib/activityDisplay';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { embeddedAttachmentIds } from '../../lib/media';
import { timestampLabel } from '../../lib/issueDisplay';
import { useOptimisticRecord } from '../../lib/optimistic';
import { issuePath, teamPath } from '../../lib/paths';
import { showErrorToast, showToast } from '../../lib/toast';
import {
  activityKey,
  childrenKey,
  cyclesKey,
  issueKey,
  linksKey,
  projectsKey,
} from '../../lib/queryKeys';
import {
  COPY_ISSUE_ID_KEYS,
  COPY_ISSUE_URL_KEYS,
  copyText,
} from '../../lib/copyIssue';
import type { IssueRead, IssueUpdate, LinkType } from '../../types/Api';

/** How often the issue and its supporting lists are re-read. */
const POLL_MS = 60000;

/** How many sub-issues one page asks for. */
const CHILDREN_PAGE = 50;

/** The team link in the page bar, in the shared link colour. */
const TEAM_LINK_CLASS = `${LINK_CLASS} truncate font-normal`;

/** The keys for each issue command, shown in the menu and the palette. */
const KEYS = {
  addLink: 'mod+l',
  addSubIssue: 'mod+shift+o',
  blockedBy: 'm b',
  blocking: 'm x',
  related: 'm r',
  duplicate: 'm d',
  archive: ARCHIVE_ISSUE_KEYS,
} as const;

/** The "Mark as" commands, in menu order, with the relation each starts on. */
const RELATION_COMMANDS: {
  keys: string;
  label: string;
  type: LinkType;
  icon: IconType;
}[] = [
  {
    keys: KEYS.blockedBy,
    label: 'Mark as blocked by',
    type: 'blocked_by',
    icon: LuBan,
  },
  {
    keys: KEYS.blocking,
    label: 'Mark as blocking',
    type: 'blocks',
    icon: LuOctagonAlert,
  },
  {
    keys: KEYS.related,
    label: 'Mark as related to',
    type: 'relates_to',
    icon: LuArrowLeftRight,
  },
  {
    keys: KEYS.duplicate,
    label: 'Mark as duplicate of',
    type: 'duplicate_of',
    icon: LuCopyMinus,
  },
];

/** Binds one issue command to its keys, which also lists it in the palette. */
const IssueCommand: React.FC<{
  keys: string;
  label: string;
  enabled: boolean;
  onRun: () => void;
}> = ({ keys, label, enabled, onRun }) => {
  useShortcut({
    keys,
    label,
    scope: 'issue',
    group: 'Issue',
    enabled,
    handler: onRun,
  });
  return null;
};

/** Copies the address of this page. */
const copyIssueLink = (): void => {
  copyText(globalThis.location.href, 'Link to the issue copied');
};

/** Whether two sets hold the same ids. */
const sameIds = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((id) => b.has(id));

/** The full view of one issue. */
export const IssueDetail: React.FC = () => {
  const { slug, key } = useParams<{ slug: string; key: string }>();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const auth = useQueryAuth();
  const createIssue = useCreateIssue();
  const navigate = useNavigate();

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
  const planningEnabled = workspaceId !== '' && teamId !== '';

  const { milestones } = useProjectMilestones(
    workspaceId,
    issue?.project_id ?? ''
  );

  const { data: teams } = useTeams();
  const options = useTeamOptions(workspaceId, teamId, { parents: true });

  const { data: cycles } = usePolledQuery(
    ({ signal }) => listCycles(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled: planningEnabled,
      queryKey: cyclesKey(workspaceId, teamId, ''),
      auth,
    }
  );

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, { team_id: teamId }, signal),
    {
      intervalMs: POLL_MS,
      enabled: planningEnabled,
      queryKey: projectsKey(workspaceId, teamId, ''),
      auth,
    }
  );

  const { data: linkRows } = usePolledQuery(
    ({ signal }) => listLinks(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '' && issueId !== '',
      queryKey: linksKey(issueId),
      auth,
    }
  );
  const links = useMemo(() => linkRows ?? [], [linkRows]);

  const readChildren = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<IssueRead>> => {
      const page = await listChildren(
        workspaceId,
        issueId,
        { limit: CHILDREN_PAGE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      );
      return { rows: page.issues, nextCursor: page.next_cursor };
    },
    [workspaceId, issueId]
  );
  const mergeChildren = useCallback(
    (held: IssueRead[], incoming: IssueRead[]): IssueRead[] =>
      appendIssues(held, { issues: incoming, next_cursor: null }),
    []
  );
  const children = useCursorPages(readChildren, mergeChildren, {
    queryKey: childrenKey(issueId),
    enabled: workspaceId !== '' && issueId !== '',
    intervalMs: POLL_MS,
  });
  const {
    hasMore: childrenHasMore,
    isPaging: childrenPaging,
    isLoading: childrenLoading,
    loadMore: loadMoreChildren,
  } = children;
  useEffect(() => {
    if (childrenHasMore && !childrenPaging && !childrenLoading) {
      loadMoreChildren();
    }
  }, [childrenHasMore, childrenPaging, childrenLoading, loadMoreChildren]);

  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const onCommentAttachments = useCallback((ids: Set<string>) => {
    setHiddenIds((held) => (sameIds(held, ids) ? held : ids));
  }, []);

  const issueBody = issue?.body;
  const railHiddenIds = useMemo(() => {
    const embedded = embeddedAttachmentIds(issueBody);
    if (embedded.length === 0) return hiddenIds;
    return new Set([...hiddenIds, ...embedded]);
  }, [hiddenIds, issueBody]);

  const [linkOpen, setLinkOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [relation, setRelation] = useState<LinkType | 'any' | null>(null);
  const [moving, setMoving] = useState(false);

  const canonicalKey = data?.key;
  useEffect(() => {
    if (canonicalKey !== undefined && canonicalKey !== issueRef) {
      void navigate(issuePath(slug ?? '', canonicalKey), { replace: true });
    }
  }, [canonicalKey, issueRef, navigate, slug]);

  const attachFiles = useAttachFiles(workspaceId, issueId);

  const team = teams?.find((item) => item.id === teamId);
  const canEdit = canWriteIssues(workspace?.role, team?.role);
  const isAdmin = isTeamAdmin(workspace?.role, team?.role);
  const currentUserId = user?.id ?? '';

  const parents = options.parents.filter(
    (candidate) =>
      candidate.id !== issue?.id && candidate.parent_id !== issue?.id
  );

  const context = useMemo<ActivityContext>(
    () => ({
      statuses: options.statuses.map((status) => ({
        id: status.id,
        name: status.name,
        category: status.category,
      })),
      people: options.people,
      labels: options.labels.map((label) => ({
        id: label.id,
        name: label.name,
      })),
      issues: [
        ...options.parents.map((row) => ({ id: row.id, key: row.key })),
        ...children.rows.map((row) => ({ id: row.id, key: row.key })),
        ...links.map((link) => ({
          id: link.target_issue_id,
          key: link.target_key,
        })),
      ],
      projects: (projects?.projects ?? []).map((project) => ({
        id: project.project_id,
        name: project.name,
      })),
      cycles: (cycles?.cycles ?? []).map((cycle) => ({
        id: cycle.cycle_id,
        name: cycle.name,
      })),
    }),
    [
      options.statuses,
      options.people,
      options.labels,
      options.parents,
      children.rows,
      links,
      projects,
      cycles,
    ]
  );

  const onUpdate = (patch: IssueUpdate): void => {
    void update(patch);
  };

  const ready = issue !== null && team !== undefined;
  const canAct = ready && canEdit;

  const addSubIssue = (): void => {
    if (issue === null) return;
    createIssue.open({
      teamId: issue.team_id,
      parentId: issue.id,
      parentKey: issue.key,
      onCreated: () => {
        invalidateQueries([childrenKey(issue.id), activityKey(issue.id)]);
      },
    });
  };

  const removeIssue = async (): Promise<void> => {
    if (issue === null || team === undefined) return;
    try {
      await deleteIssue(workspaceId, issue.id);
    } catch (cause) {
      showErrorToast(errorMessage(cause, 'Could not delete that issue.'));
      return;
    }
    showToast(`${issue.key} deleted`);
    void navigate(teamPath(slug ?? '', team.key_prefix));
  };

  const archived = issue !== null && (issue.archived_at ?? null) !== null;

  const toggleArchive = async (): Promise<void> => {
    if (issue === null) return;
    const restoring = (issue.archived_at ?? null) !== null;
    try {
      const saved = restoring
        ? await unarchiveIssue(workspaceId, issue.id)
        : await archiveIssue(workspaceId, issue.id);
      receive(saved);
    } catch (cause) {
      showErrorToast(
        errorMessage(
          cause,
          restoring
            ? 'Could not restore that issue.'
            : 'Could not archive that issue.'
        )
      );
      return;
    }
    invalidateQueries([issueKey(workspaceId, issueRef), activityKey(issue.id)]);
    showToast(restoring ? `${issue.key} restored` : `${issue.key} archived`);
  };

  const onMoved = (moved: IssueRead): void => {
    invalidateQueries([issueKey(workspaceId, issueRef), activityKey(moved.id)]);
    void navigate(issuePath(slug ?? '', moved.key), { replace: true });
  };

  const copyIssueId = (): void => {
    if (issue !== null) copyText(issue.key, 'Issue ID copied');
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

  const actions =
    issue === null ? undefined : (
      <div className="flex items-center gap-1">
        <IssueTrailNav slug={slug ?? ''} issueKey={issueRef} />
        {canEdit && (
          <ShareButton
            workspaceId={workspaceId}
            targetType="issue"
            targetId={issue.id}
          />
        )}
        <Menu
          label="Issue actions"
          align="end"
          className="min-w-0"
          trigger={(props) => (
            <IconButton label="Issue actions" size="sm" {...props}>
              <LuEllipsis className="h-4 w-4" />
            </IconButton>
          )}
        >
          {canAct && (
            <>
              <MenuItem
                onSelect={() => {
                  setLinkOpen(true);
                }}
              >
                <LuLink2 aria-hidden="true" className="h-3.5 w-3.5" />
                Add link
                <MenuShortcut keys={KEYS.addLink} />
              </MenuItem>
              <MenuItem onSelect={addSubIssue}>
                <LuListTree aria-hidden="true" className="h-3.5 w-3.5" />
                Add sub-issue
                <MenuShortcut keys={KEYS.addSubIssue} />
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  setMoving(true);
                }}
              >
                <LuUsers aria-hidden="true" className="h-3.5 w-3.5" />
                {`${MOVE_ISSUE_LABEL}…`}
                <MenuShortcut keys={MOVE_ISSUE_KEYS} />
              </MenuItem>
              <MenuSeparator />
              {RELATION_COMMANDS.map((command) => (
                <MenuItem
                  key={command.type}
                  onSelect={() => {
                    setRelation(command.type);
                  }}
                >
                  <command.icon aria-hidden="true" className="h-3.5 w-3.5" />
                  {`${command.label}…`}
                  <MenuShortcut keys={command.keys} />
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                onSelect={() => {
                  void toggleArchive();
                }}
              >
                {archived ? (
                  <LuArchiveRestore
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                  />
                ) : (
                  <LuArchive aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {archived ? 'Restore issue' : 'Archive issue'}
                <MenuShortcut keys={KEYS.archive} />
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuItem onSelect={copyIssueId}>
            <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
            Copy ID
            <MenuShortcut keys={COPY_ISSUE_ID_KEYS} />
          </MenuItem>
          <MenuItem onSelect={copyIssueLink}>
            <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
            Copy link
            <MenuShortcut keys={COPY_ISSUE_URL_KEYS} />
          </MenuItem>
          {canAct && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  setDeleting(true);
                }}
              >
                <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                Delete
                <MenuShortcut keys={DELETE_ISSUE_KEYS} />
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    );

  return (
    <WorkspaceShell flush title={title} actions={actions}>
      <Toaster />
      <IssueCommand
        keys={KEYS.addLink}
        label="Add link"
        enabled={canAct}
        onRun={() => {
          setLinkOpen(true);
        }}
      />
      <IssueCommand
        keys={COPY_ISSUE_ID_KEYS}
        label="Copy issue ID"
        enabled={issue !== null}
        onRun={copyIssueId}
      />
      <IssueCommand
        keys={COPY_ISSUE_URL_KEYS}
        label="Copy issue URL"
        enabled={issue !== null}
        onRun={copyIssueLink}
      />
      <IssueCommand
        keys={KEYS.archive}
        label={archived ? 'Restore issue' : 'Archive issue'}
        enabled={canAct}
        onRun={() => {
          void toggleArchive();
        }}
      />
      <IssueCommand
        keys={KEYS.addSubIssue}
        label="Add sub-issue"
        enabled={canAct}
        onRun={addSubIssue}
      />
      <IssueCommand
        keys={MOVE_ISSUE_KEYS}
        label={`${MOVE_ISSUE_LABEL}…`}
        enabled={canAct}
        onRun={() => {
          setMoving(true);
        }}
      />
      {RELATION_COMMANDS.map((command) => (
        <IssueCommand
          key={command.type}
          keys={command.keys}
          label={`${command.label}…`}
          enabled={canAct}
          onRun={() => {
            setRelation(command.type);
          }}
        />
      ))}
      {issue !== null && team !== undefined && (
        <IssuePageCommands
          slug={slug ?? ''}
          issue={issue}
          statuses={options.statuses}
          labels={options.labels}
          people={options.people}
          projects={projects?.projects ?? []}
          cycles={cycles?.cycles ?? []}
          milestones={milestones}
          estimateScale={team.estimate_scale}
          currentUserId={currentUserId}
          canEdit={canEdit}
          onUpdate={onUpdate}
          onDelete={removeIssue}
          deleting={deleting}
          onDeletingChange={setDeleting}
        />
      )}

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
        <IssueMediaProvider workspaceId={workspaceId} issueId={issue.id}>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
            <div className="order-2 min-w-0 flex-1 lg:order-1 lg:overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8 lg:px-12 lg:py-10">
                {archived && (
                  <div
                    role="status"
                    className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-text-muted"
                  >
                    <LuArchive
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      Archived {timestampLabel(issue.archived_at ?? '')}. It is
                      hidden from lists and boards.
                    </span>
                    {canAct && (
                      <button
                        type="button"
                        className={LINK_CLASS}
                        onClick={() => {
                          void toggleArchive();
                        }}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                )}
                <IssueBody
                  workspaceId={workspaceId}
                  issue={issue}
                  canEdit={canEdit}
                  onSaved={receive}
                  onDropFiles={attachFiles}
                />

                <ReactionBar
                  workspaceId={workspaceId}
                  targetId={issue.id}
                  targetKind="issue"
                  canReact={canEdit}
                />

                <div className="border-t border-line pt-6">
                  <IssueTimeline
                    workspaceId={workspaceId}
                    issueId={issue.id}
                    currentUserId={currentUserId}
                    canComment={canEdit}
                    isAdmin={isAdmin}
                    context={context}
                    slug={slug ?? ''}
                    teamKeyPrefix={team?.key_prefix ?? ''}
                    onCommentAttachments={onCommentAttachments}
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
                  <PropertySection title="Team">
                    <IssueTeamRow
                      team={team}
                      canMove={canAct}
                      onMove={() => {
                        setMoving(true);
                      }}
                    />
                  </PropertySection>
                )}
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
                    showParent={false}
                    {...(isAdmin ? { onCreateLabel: options.createLabel } : {})}
                    onUpdate={onUpdate}
                  />
                )}

                <GithubIssueSection
                  workspaceId={workspaceId}
                  issueId={issue.id}
                />

                {team !== undefined && (
                  <PlanningPickers
                    workspaceId={workspaceId}
                    teamId={teamId}
                    issue={issue}
                    canEdit={canEdit}
                    onUpdate={onUpdate}
                    projects={projects?.projects ?? []}
                    cycles={cycles?.cycles ?? []}
                  />
                )}

                <IssueParent
                  workspaceId={workspaceId}
                  slug={slug ?? ''}
                  issue={issue}
                  candidates={parents}
                  statuses={options.statuses}
                  canEdit={canEdit}
                  onChange={(parentId) => {
                    onUpdate({ parent_id: parentId });
                  }}
                />

                <SubIssues
                  slug={slug ?? ''}
                  rows={children.rows}
                  isLoading={children.isLoading}
                  error={children.error}
                  progress={issue.progress}
                  statuses={options.statuses}
                  people={options.people}
                  {...(canAct ? { onAdd: addSubIssue } : {})}
                />

                <IssueRelations
                  workspaceId={workspaceId}
                  issueId={issue.id}
                  slug={slug ?? ''}
                  links={links}
                  canEdit={canEdit}
                  onAdd={() => {
                    setRelation('any');
                  }}
                />

                <IssueResources
                  workspaceId={workspaceId}
                  issueId={issue.id}
                  currentUserId={currentUserId}
                  canEdit={canEdit}
                  isAdmin={isAdmin}
                  hiddenIds={railHiddenIds}
                  onAddLink={() => {
                    setLinkOpen(true);
                  }}
                  onAttachFiles={attachFiles}
                />

                <GithubLinksSection
                  workspaceId={workspaceId}
                  issueId={issue.id}
                  issueKey={issue.key}
                  title={issue.title}
                />

                <IssueSubscribers
                  workspaceId={workspaceId}
                  issueId={issue.id}
                />

                <p className="text-xs text-text-faint">
                  Last updated {timestampLabel(issue.updated_at)}
                </p>
              </div>
            </aside>

            <MoveIssueDialog
              open={moving}
              workspaceId={workspaceId}
              workspaceRole={workspace?.role}
              issue={issue}
              teams={teams ?? []}
              onClose={() => {
                setMoving(false);
              }}
              onMoved={onMoved}
            />
            <AddLinkDialog
              workspaceId={workspaceId}
              issueId={issue.id}
              open={linkOpen}
              onClose={() => {
                setLinkOpen(false);
              }}
            />
            <AddRelationDialog
              workspaceId={workspaceId}
              issueId={issue.id}
              open={relation !== null}
              {...(relation === null || relation === 'any'
                ? {}
                : { initialType: relation })}
              onClose={() => {
                setRelation(null);
              }}
              onLinked={() => {
                invalidateQueries(issueKey(workspaceId, issueRef));
              }}
            />
          </div>
        </IssueMediaProvider>
      )}
    </WorkspaceShell>
  );
};

export default IssueDetail;
