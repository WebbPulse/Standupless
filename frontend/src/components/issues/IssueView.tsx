/**
 * One issue in full: a centered reading column holding the title, the
 * description, the sub-issues and one timeline of changes and comments, with
 * the compact properties panel beside it. The issue page and the inbox's
 * reading pane both render this, so an issue reads and edits the same way
 * wherever it is opened, and only the frame around it differs: the page puts
 * it in the workspace shell with the list pager, and the pane puts it under
 * its own bar with a link to the full page.
 *
 * Where the frame is too narrow for the panel beside the column, the panel
 * drops between the description and the timeline. The layout follows the
 * frame's own width through a container query rather than the window's, so
 * the same view fits a full page and a pane beside a list. Cmd or Ctrl+I, or
 * the panel button in the bar, hides the panel so the column reads at full
 * width, and the viewer's choice holds on every issue and in the pane. The
 * property keys still open their pickers while it is hidden.
 *
 * Adding a link, a sub-issue, a relation or a parent opens a dialog from the issue
 * menu, the panel's "+" menu, the command palette or a shortcut. Duplicate
 * issue files a copy and opens it, and Convert to project asks first, then
 * opens the project the issue became. The caller's
 * subscription is read once here and shared by the bell in the bar, the
 * Subscribers section, the shortcut and the palette, so they never disagree. An archived
 * issue still opens here, under a banner that restores it. The supporting
 * lists are read once here and handed down, so the panel and the timeline
 * resolve the same ids without reading them twice.
 *
 * Remind me, from the menu, the palette or H, brings the issue back to the
 * caller's inbox at a moment they pick, and a pending reminder shows above the
 * description with ways to change or cancel it. In a pane beside a list H stays
 * with the list, so the command is reached through the menu and the palette.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuArchive,
  LuArchiveRestore,
  LuChevronRight,
  LuClock,
  LuCopy,
  LuCopyPlus,
  LuCornerUpLeft,
  LuEllipsis,
  LuFileText,
  LuGitBranch,
  LuHexagon,
  LuHistory,
  LuLink2,
  LuListTree,
  LuMaximize2,
  LuPanelRight,
  LuTrash2,
  LuUnlink,
  LuUsers,
  LuX,
} from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  appendIssues,
  archiveIssue,
  deleteIssue,
  getIssue,
  getIssueByKey,
  listChildren,
  listLinks,
  unarchiveIssue,
  updateIssue,
} from '../../api/issues';
import { listCycles, listProjects } from '../../api/planning';
import { useAttachFiles } from '../../hooks/useAttachFiles';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useQuoteRequest } from '../../hooks/useQuoteRequest';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import {
  DETAILS_PANEL_KEYS,
  detailsPanelLabel,
  detailsPanelTitle,
  useDetailsPanel,
} from '../../hooks/useDetailsPanel';
import {
  REMIND_ME_KEYS,
  REMIND_ME_LABEL,
  useIssueReminder,
} from '../../hooks/useIssueReminder';
import { useIssueSubscription } from '../../hooks/useIssueSubscription';
import { useProjectMilestones } from '../../hooks/useProjectMilestones';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { useTeams } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { ActivityContext } from '../../lib/activityDisplay';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import {
  COPY_BRANCH_KEYS,
  COPY_ISSUE_ID_KEYS,
  COPY_ISSUE_MARKDOWN_LABEL,
  COPY_ISSUE_URL_KEYS,
  copyBranchName,
  copyIssueMarkdown,
  copyText,
  issueUrl,
} from '../../lib/copyIssue';
import { errorMessage } from '../../lib/errors';
import { useRecordRecentIssue } from '../../lib/recentIssues';
import { timestampLabel } from '../../lib/issueDisplay';
import {
  CONVERT_TO_PROJECT_LABEL,
  DUPLICATE_ISSUE_LABEL,
  convertedPath,
  duplicatePath,
  runDuplicate,
} from '../../lib/issueConversion';
import { recordArchive, recordPatch } from '../../lib/issueUndo';
import { embeddedAttachmentIds } from '../../lib/media';
import { reminderLabel } from '../../lib/reminders';
import { useOptimisticRecord } from '../../lib/optimistic';
import { issuePath, teamPath } from '../../lib/paths';
import {
  activityKey,
  childrenKey,
  cyclesKey,
  issueKey,
  linksKey,
  projectsKey,
} from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import { estimateOptionsOf } from '../../lib/validation';
import type { IssueRead, IssueUpdate, LinkType } from '../../types/Api';
import ShareButton from '../access/ShareButton';
import ReactionBar from '../discussion/ReactionBar';
import IssueMediaProvider from '../media/IssueMediaProvider';
import { ErrorAlert } from '../ui/alert';
import { Button, IconButton } from '../ui/button';
import Tooltip from '../ui/tooltip';
import { LINK_CLASS } from '../ui/link';
import Menu, { MenuItem, MenuSeparator, MenuShortcut } from '../ui/menu';
import Spinner from '../ui/spinner';
import { useTruncationTooltip } from '../ui/truncated-text';
import { Toaster } from '../ui/toast';
import AddLinkDialog from './AddLinkDialog';
import AddRelationDialog from './AddRelationDialog';
import DescriptionHistoryDialog, {
  DESCRIPTION_HISTORY_LABEL,
} from './DescriptionHistoryDialog';
import IssueBody from './IssueBody';
import IssuePageCommands from './IssuePageCommands';
import IssuePropertiesPanel from './IssuePropertiesPanel';
import { RelationMarkers } from './BlockedMarker';
import { RELATION_COMMANDS } from './RelationGlyphs';
import IssueSubscribeButton from './IssueSubscribeButton';
import RemindMeDialog from './RemindMeDialog';
import FavoriteButton from '../ui/FavoriteButton';
import IssueTimeline from './IssueTimeline';
import {
  DocumentLinkContext,
  issueDocumentParent,
} from '../../contexts/DocumentLinkContext';
import IssueTrailNav from './IssueTrailNav';
import MoveIssueDialog, {
  MOVE_ISSUE_KEYS,
  MOVE_ISSUE_LABEL,
} from './MoveIssueDialog';
import ConvertToProjectDialog from './ConvertToProjectDialog';
import SetParentDialog, { SET_PARENT_KEYS } from './SetParentDialog';
import SubIssues from './SubIssues';
import { ARCHIVE_ISSUE_KEYS, DELETE_ISSUE_KEYS } from './view/propertyKeys';

/** How often the issue and its supporting lists are re-read. */
const POLL_MS = 60000;

/** How many sub-issues one page asks for. */
const CHILDREN_PAGE = 50;

/** The team link in the bar, in the shared link colour. */
const TEAM_LINK_CLASS = `${LINK_CLASS} truncate font-normal`;

/** The keys for each issue command, shown in the menu and the palette. */
const KEYS = {
  addLink: 'mod+l',
  addSubIssue: 'mod+shift+o',
  archive: ARCHIVE_ISSUE_KEYS,
} as const;

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

/** Whether two sets hold the same ids. */
const sameIds = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((id) => b.has(id));

/** The pieces a frame lays out: the bar's title and actions, and the view. */
export interface IssueViewParts {
  title: ReactNode;
  /** The issue as plain text, its key and title, for a desktop tab. */
  label: string;
  /** The favorite star a full page shows right after the title; a pane keeps it in its actions. */
  titleAccessory?: ReactNode;
  actions?: ReactNode;
  content: ReactNode;
}

/** Props for IssueView. */
export interface IssueViewProps {
  /** The issue's key, or its id when `lookup` is `'id'`. */
  issueRef: string;
  /** How `issueRef` names the issue. Defaults to the key. */
  lookup?: 'key' | 'id';
  /**
   * Set when the view sits in a pane beside a list rather than on its own
   * page. The bar then links to the full page and closes the pane instead of
   * showing the list pager, and the address is left alone.
   */
  onClose?: () => void;
  /** Lays out the bar and the view, such as inside the workspace shell. */
  frame: (parts: IssueViewParts) => ReactNode;
}

/** The full view of one issue, inside whatever frame the caller gives it. */
export const IssueView: React.FC<IssueViewProps> = ({
  issueRef,
  lookup = 'key',
  onClose,
  frame,
}) => {
  const params = useParams<{ slug: string }>();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const auth = useQueryAuth();
  const createIssue = useCreateIssue();
  const navigate = useNavigate();
  const embedded = onClose !== undefined;
  const slug = params.slug ?? workspace?.slug ?? '';

  const workspaceId = workspace?.id ?? '';
  const enabled = workspaceId !== '' && issueRef !== '';

  const { data, error, isLoading } = usePolledQuery(
    (context) =>
      lookup === 'id'
        ? getIssue(workspaceId, issueRef, context)
        : getIssueByKey(workspaceId, issueRef, context),
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
  useRecordRecentIssue(workspaceId, user?.id, issueRef, issue, error);

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
  const descriptionQuotes = useQuoteRequest(issue?.id ?? '');
  const onCommentAttachments = useCallback((ids: Set<string>) => {
    setHiddenIds((held) => (sameIds(held, ids) ? held : ids));
  }, []);

  const issueBody = issue?.body;
  const panelHiddenIds = useMemo(() => {
    const embeddedIds = embeddedAttachmentIds(issueBody);
    if (embeddedIds.length === 0) return hiddenIds;
    return new Set([...hiddenIds, ...embeddedIds]);
  }, [hiddenIds, issueBody]);

  const [linkOpen, setLinkOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [relation, setRelation] = useState<LinkType | 'any' | null>(null);
  const [moving, setMoving] = useState(false);
  const [parenting, setParenting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [history, setHistory] = useState(false);

  const canonicalKey = data?.key;
  const redirectRef = useRef(issueRef);
  useEffect(() => {
    const refChanged = redirectRef.current !== issueRef;
    redirectRef.current = issueRef;
    if (refChanged || embedded || lookup !== 'key') return;
    if (canonicalKey !== undefined && canonicalKey !== issueRef) {
      void navigate(issuePath(slug, canonicalKey), { replace: true });
    }
  }, [embedded, lookup, canonicalKey, issueRef, navigate, slug]);

  const attachFiles = useAttachFiles(workspaceId, issueId);
  const subscription = useIssueSubscription(workspaceId, issueId);
  const detailsPanel = useDetailsPanel();
  const reminder = useIssueReminder(workspaceId, issueId);
  const teamTip = useTruncationTooltip<HTMLAnchorElement>();
  const remindKeys = embedded ? '' : REMIND_ME_KEYS;

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
      statuses: options.statuses,
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
    const before = issue;
    void update(patch).then((saved) => {
      if (!saved || before === null) return;
      recordPatch(workspaceId, before, patch, {
        invalidate: [issueKey(workspaceId, issueRef)],
        onReverted: ([written]) => {
          if (written !== undefined) receive(written);
        },
      });
    });
  };

  const ready = issue !== null && team !== undefined;
  const canAct = ready && canEdit;

  const removeParent = (): void => {
    if (issue === null || issue.parent_id === null) return;
    onUpdate({ parent_id: null });
  };

  const duplicate = async (): Promise<void> => {
    if (issue === null) return;
    const copy = await runDuplicate(workspaceId, issue);
    if (copy !== null) void navigate(duplicatePath(slug, copy));
  };

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
    if (onClose === undefined) {
      void navigate(teamPath(slug, team.key_prefix));
    } else {
      onClose();
    }
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
    recordArchive(workspaceId, [issue], restoring, {
      invalidate: [issueKey(workspaceId, issueRef)],
      onReverted: ([written]) => {
        if (written !== undefined) receive(written);
      },
    });
  };

  const onMoved = (moved: IssueRead): void => {
    invalidateQueries([issueKey(workspaceId, issueRef), activityKey(moved.id)]);
    if (!embedded) {
      void navigate(issuePath(slug, moved.key), { replace: true });
    }
  };

  const fullPath = issue === null ? '' : issuePath(slug, issue.key);

  const copyIssueId = (): void => {
    if (issue !== null) copyText(issue.key, 'Issue ID copied');
  };

  const copyIssueLink = (): void => {
    const href = embedded
      ? `${globalThis.location.origin}${fullPath}`
      : globalThis.location.href;
    copyText(href, 'Link to the issue copied');
  };

  const shownKey = issue?.key ?? (lookup === 'key' ? issueRef : '');

  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      {team !== undefined && (
        <>
          <Link
            ref={teamTip.ref}
            to={teamPath(slug, team.key_prefix)}
            className={TEAM_LINK_CLASS}
            {...teamTip.handlers}
          >
            {team.name}
          </Link>
          {teamTip.tip}
          <LuChevronRight
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-text-faint"
          />
        </>
      )}
      <span className="font-mono text-text-muted">{shownKey}</span>
      {issue !== null && <RelationMarkers issue={issue} />}
    </span>
  );

  const favorite =
    issue === null ? undefined : (
      <FavoriteButton
        workspaceId={workspaceId}
        kind="issue"
        targetId={issue.id}
        title={issue.title}
        preview={{ issue_key: issue.key }}
        scope="issue"
      />
    );

  const actions =
    issue === null ? undefined : (
      <div className="flex items-center gap-1">
        {!embedded && (
          <span className="hidden sm:contents">
            <IssueTrailNav slug={slug} issueKey={issueRef} />
          </span>
        )}
        {embedded && favorite}
        <IssueSubscribeButton subscription={subscription} />
        <Tooltip text={detailsPanelTitle(detailsPanel.shown)}>
          <Button
            aria-label={detailsPanelLabel(detailsPanel.shown)}
            aria-pressed={detailsPanel.shown}
            size="sm"
            variant="ghost"
            className="w-7 px-0 pointer-coarse:w-11"
            onClick={detailsPanel.toggle}
          >
            <LuPanelRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Tooltip>
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
              <MenuItem
                onSelect={() => {
                  setParenting(true);
                }}
              >
                <LuCornerUpLeft aria-hidden="true" className="h-3.5 w-3.5" />
                Set parent issue…
                <MenuShortcut keys={SET_PARENT_KEYS} />
              </MenuItem>
              {(issue?.parent_id ?? null) !== null && (
                <MenuItem onSelect={removeParent}>
                  <LuUnlink aria-hidden="true" className="h-3.5 w-3.5" />
                  Remove parent
                </MenuItem>
              )}
              <MenuItem
                onSelect={() => {
                  void duplicate();
                }}
              >
                <LuCopyPlus aria-hidden="true" className="h-3.5 w-3.5" />
                {DUPLICATE_ISSUE_LABEL}
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  setConverting(true);
                }}
              >
                <LuHexagon aria-hidden="true" className="h-3.5 w-3.5" />
                {`${CONVERT_TO_PROJECT_LABEL}…`}
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
          <MenuItem
            onSelect={() => {
              setReminding(true);
            }}
          >
            <LuClock aria-hidden="true" className="h-3.5 w-3.5" />
            {`${REMIND_ME_LABEL}…`}
            {remindKeys !== '' && <MenuShortcut keys={remindKeys} />}
          </MenuItem>
          <MenuItem
            onSelect={() => {
              setHistory(true);
            }}
          >
            <LuHistory aria-hidden="true" className="h-3.5 w-3.5" />
            {`${DESCRIPTION_HISTORY_LABEL}…`}
          </MenuItem>
          <MenuSeparator />
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
          <MenuItem
            onSelect={() => {
              if (issue === null) return;
              copyBranchName(
                issue.key,
                issue.title,
                canAct
                  ? {
                      issue,
                      statuses: options.statuses,
                      currentUserId,
                      apply: onUpdate,
                    }
                  : undefined
              );
            }}
          >
            <LuGitBranch aria-hidden="true" className="h-3.5 w-3.5" />
            Copy git branch name
            <MenuShortcut keys={COPY_BRANCH_KEYS} />
          </MenuItem>
          <MenuItem
            onSelect={() => {
              if (issue === null) return;
              copyIssueMarkdown(issue, issueUrl(slug, issue.key), {
                statuses: options.statuses,
                labels: options.labels,
                people: options.people,
                projects: projects?.projects ?? [],
                cycles: cycles?.cycles ?? [],
              });
            }}
          >
            <LuFileText aria-hidden="true" className="h-3.5 w-3.5" />
            {COPY_ISSUE_MARKDOWN_LABEL}
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
        {embedded && (
          <>
            <Link
              to={fullPath}
              aria-label="Open full page"
              title="Open full page"
              className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-muted transition-colors duration-100 hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              <LuMaximize2 aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <LuX className="h-4 w-4" />
            </IconButton>
          </>
        )}
      </div>
    );

  const showSubIssues =
    issue !== null && (children.rows.length > 0 || issue.progress.total > 0);

  const content = (
    <>
      <Toaster />
      <IssueCommand
        keys={DETAILS_PANEL_KEYS}
        label={detailsPanelLabel(detailsPanel.shown)}
        enabled={issue !== null}
        onRun={detailsPanel.toggle}
      />
      <IssueCommand
        keys={KEYS.addLink}
        label="Add link"
        enabled={canAct}
        onRun={() => {
          setLinkOpen(true);
        }}
      />
      <IssueCommand
        keys={remindKeys}
        label={`${REMIND_ME_LABEL}…`}
        enabled={issue !== null}
        onRun={() => {
          setReminding(true);
        }}
      />
      <IssueCommand
        keys=""
        label={`${DESCRIPTION_HISTORY_LABEL}…`}
        enabled={issue !== null}
        onRun={() => {
          setHistory(true);
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
        keys={SET_PARENT_KEYS}
        label="Set parent issue…"
        enabled={canAct && issue !== null}
        onRun={() => {
          setParenting(true);
        }}
      />
      <IssueCommand
        keys=""
        label="Remove parent"
        enabled={canAct && (issue?.parent_id ?? null) !== null}
        onRun={removeParent}
      />
      <IssueCommand
        keys=""
        label={DUPLICATE_ISSUE_LABEL}
        enabled={canAct}
        onRun={() => {
          void duplicate();
        }}
      />
      <IssueCommand
        keys=""
        label={`${CONVERT_TO_PROJECT_LABEL}…`}
        enabled={canAct}
        onRun={() => {
          setConverting(true);
        }}
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
          slug={slug}
          issue={issue}
          statuses={options.statuses}
          labels={options.labels}
          people={options.people}
          projects={projects?.projects ?? []}
          cycles={cycles?.cycles ?? []}
          milestones={milestones}
          estimateScale={team.estimate_scale}
          estimateOptions={estimateOptionsOf(team)}
          currentUserId={currentUserId}
          canEdit={canEdit}
          onUpdate={onUpdate}
          onDelete={removeIssue}
          deleting={deleting}
          onDeletingChange={setDeleting}
          knownIssues={options.parents}
          subIssues={children.rows}
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
          <div className="@container relative min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[1024px] flex-col gap-6 px-4 py-6 sm:px-8 @min-[860px]:flex-row @min-[860px]:items-start @min-[860px]:justify-center @min-[860px]:gap-10 @min-[860px]:py-10">
              <div className="contents @min-[860px]:block @min-[860px]:min-w-0 @min-[860px]:max-w-[680px] @min-[860px]:flex-1">
                <div className="order-1 min-w-0 space-y-6">
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
                        Archived {timestampLabel(issue.archived_at ?? '')}. It
                        is hidden from lists and boards.
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
                  {reminder.reminder !== null && (
                    <div
                      role="status"
                      className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-text-muted"
                    >
                      <LuClock
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        Reminder set for{' '}
                        {reminderLabel(reminder.reminder.remind_at)}.
                      </span>
                      <button
                        type="button"
                        className={LINK_CLASS}
                        onClick={() => {
                          setReminding(true);
                        }}
                      >
                        Change
                      </button>
                      <button
                        type="button"
                        className={LINK_CLASS}
                        onClick={reminder.cancel}
                      >
                        Cancel reminder
                      </button>
                    </div>
                  )}
                  <IssueBody
                    workspaceId={workspaceId}
                    issue={issue}
                    canEdit={canEdit}
                    onSaved={receive}
                    people={options.people}
                    onDropFiles={attachFiles}
                    canComment={canEdit}
                    {...(canEdit ? { onQuote: descriptionQuotes.ask } : {})}
                  />

                  <ReactionBar
                    workspaceId={workspaceId}
                    targetId={issue.id}
                    targetKind="issue"
                    canReact={canEdit}
                  />

                  {showSubIssues && (
                    <SubIssues
                      workspaceId={workspaceId}
                      slug={slug}
                      parent={issue}
                      rows={children.rows}
                      isLoading={children.isLoading}
                      error={children.error}
                      progress={issue.progress}
                      statuses={options.statuses}
                      people={options.people}
                      canEdit={canAct}
                      currentUserId={currentUserId}
                    />
                  )}
                </div>

                <div className="order-3 min-w-0 border-t border-line pt-6 @min-[860px]:mt-8">
                  <DocumentLinkContext.Provider
                    value={issueDocumentParent(issue.project_id)}
                  >
                    <IssueTimeline
                      workspaceId={workspaceId}
                      issueId={issue.id}
                      currentUserId={currentUserId}
                      canComment={canEdit}
                      isAdmin={isAdmin}
                      context={context}
                      slug={slug}
                      teamKeyPrefix={team?.key_prefix ?? ''}
                      onCommentAttachments={onCommentAttachments}
                      quote={descriptionQuotes.request}
                    />
                  </DocumentLinkContext.Provider>
                </div>
              </div>

              {team !== undefined && detailsPanel.shown && (
                <IssuePropertiesPanel
                  className="order-2 @min-[860px]:sticky @min-[860px]:top-6 @min-[860px]:max-h-[calc(100dvh-8rem)] @min-[860px]:w-60 @min-[860px]:overflow-y-auto"
                  workspaceId={workspaceId}
                  slug={slug}
                  issue={issue}
                  team={team}
                  teams={teams ?? []}
                  estimateOptions={estimateOptionsOf(team)}
                  statuses={options.statuses}
                  labels={options.labels}
                  people={options.people}
                  parents={parents}
                  projects={projects?.projects ?? []}
                  cycles={cycles?.cycles ?? []}
                  links={links}
                  canEdit={canEdit}
                  canAct={canAct}
                  isAdmin={isAdmin}
                  currentUserId={currentUserId}
                  hiddenIds={panelHiddenIds}
                  onUpdate={onUpdate}
                  {...(isAdmin ? { onCreateLabel: options.createLabel } : {})}
                  onMove={() => {
                    setMoving(true);
                  }}
                  onAddSubIssue={addSubIssue}
                  onAddRelation={() => {
                    setRelation('any');
                  }}
                  onAddLink={() => {
                    setLinkOpen(true);
                  }}
                  onAttachFiles={attachFiles}
                  subscription={subscription}
                />
              )}
            </div>

            {parenting && (
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
            {converting && (
              <ConvertToProjectDialog
                workspaceId={workspaceId}
                issue={issue}
                onClose={() => {
                  setConverting(false);
                }}
                onConverted={(result) => {
                  void navigate(convertedPath(slug, result, team?.key_prefix));
                }}
              />
            )}
            <MoveIssueDialog
              open={moving}
              workspaceId={workspaceId}
              workspaceRole={workspace?.role}
              issues={[issue]}
              teams={teams ?? []}
              onClose={() => {
                setMoving(false);
              }}
              onMoved={([moved]) => {
                if (moved !== undefined) onMoved(moved);
              }}
            />
            <RemindMeDialog
              open={reminding}
              issueKey={issue.key}
              reminder={reminder}
              onClose={() => {
                setReminding(false);
              }}
            />
            {history && (
              <DescriptionHistoryDialog
                workspaceId={workspaceId}
                issue={issue}
                people={options.people}
                canEdit={canAct}
                onRestored={(saved) => {
                  receive(saved);
                  invalidateQueries([issueKey(workspaceId, issueRef)]);
                }}
                onClose={() => {
                  setHistory(false);
                }}
              />
            )}
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
    </>
  );

  return (
    <>
      {frame({
        title,
        label: issue === null ? shownKey : `${issue.key} ${issue.title}`,
        ...(actions === undefined ? {} : { actions }),
        ...(embedded || favorite === undefined
          ? {}
          : { titleAccessory: favorite }),
        content,
      })}
    </>
  );
};

export default IssueView;
