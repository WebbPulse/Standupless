/**
 * One issue, resolved from the `:key` in the route through the by-key read,
 * which is the address a person can type from memory. The main column holds
 * the title, the description and one timeline of changes and comments; every
 * connective piece, the parent, sub-issues, relations, links and files, lives
 * in the rail as a folding section. Adding any of them opens a dialog or picker
 * from the section header, the issue menu, the command palette or a shortcut.
 *
 * The supporting lists are read once here and handed down, so the rail and the
 * timeline resolve the same ids without reading them twice.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import type { IconType } from 'react-icons';
import {
  LuArrowLeftRight,
  LuBan,
  LuChevronRight,
  LuCopy,
  LuCopyMinus,
  LuEllipsis,
  LuLink2,
  LuListTree,
  LuOctagonAlert,
} from 'react-icons/lu';
import { Link, useParams } from 'react-router-dom';
import {
  appendIssues,
  getIssueByKey,
  listChildren,
  listLinks,
  updateIssue,
} from '../../api/issues';
import { listCycles, listProjects } from '../../api/planning';
import ShareButton from '../../components/access/ShareButton';
import ReactionBar from '../../components/discussion/ReactionBar';
import AddLinkDialog from '../../components/issues/AddLinkDialog';
import AddRelationDialog from '../../components/issues/AddRelationDialog';
import GithubLinksSection from '../../components/issues/GithubLinksSection';
import IssueSubscribers from '../../components/issues/IssueSubscribers';
import IssueBody from '../../components/issues/IssueBody';
import IssueFields from '../../components/issues/IssueFields';
import IssueParent from '../../components/issues/IssueParent';
import IssueRelations from '../../components/issues/IssueRelations';
import IssueResources from '../../components/issues/IssueResources';
import IssueTimeline from '../../components/issues/IssueTimeline';
import PlanningPickers from '../../components/issues/PlanningPickers';
import SubIssues from '../../components/issues/SubIssues';
import { ErrorAlert } from '../../components/ui/alert';
import { Kbd } from '../../components/ui/badge';
import { IconButton } from '../../components/ui/button';
import { LINK_CLASS } from '../../components/ui/link';
import Menu, { MenuItem, MenuSeparator } from '../../components/ui/menu';
import Spinner from '../../components/ui/spinner';
import { Toaster } from '../../components/ui/toast';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAttachFiles } from '../../hooks/useAttachFiles';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { displayKeys, useShortcut } from '../../hooks/useShortcuts';
import { useTeamOptions } from '../../hooks/useTeamOptions';
import { useTeams } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { ActivityContext } from '../../lib/activityDisplay';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { useOptimisticRecord } from '../../lib/optimistic';
import { teamPath } from '../../lib/paths';
import {
  activityKey,
  childrenKey,
  cyclesKey,
  issueKey,
  linksKey,
  projectsKey,
} from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
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

/** The shortcut hint at the end of a menu item. */
const KeyHint: React.FC<{ keys: string }> = ({ keys }) => (
  <span aria-hidden="true" className="ml-auto flex gap-0.5 pl-4">
    {displayKeys(keys)
      .flatMap((token) => token.split(' '))
      .map((cap, index) => (
        <Kbd key={`${cap}-${String(index)}`}>{cap}</Kbd>
      ))}
  </span>
);

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
  void navigator.clipboard
    .writeText(globalThis.location.href)
    .then(() => {
      showToast('Link to the issue copied');
    })
    .catch(() => {
      showErrorToast('Could not copy the link.');
    });
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

  const [linkOpen, setLinkOpen] = useState(false);
  const [relation, setRelation] = useState<LinkType | 'any' | null>(null);

  const attachFiles = useAttachFiles(workspaceId, issueId);

  const team = teams?.find((item) => item.id === teamId);
  const canEdit = canWriteIssues(workspace?.role, team?.role);
  const isAdmin = isTeamAdmin(workspace?.role, team?.role);
  const currentUserId = user?.id ?? '';

  const parents = options.parents.filter(
    (candidate) =>
      candidate.id !== issue?.id && candidate.parent_id !== issue?.id
  );

  const statusOf = useCallback(
    (targetId: string) => {
      const target =
        options.parents.find((row) => row.id === targetId) ??
        children.rows.find((row) => row.id === targetId);
      const status = options.statuses.find(
        (item) => item.id === target?.status_id
      );
      return status === undefined
        ? undefined
        : { name: status.name, category: status.category };
    },
    [options.parents, options.statuses, children.rows]
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
                <KeyHint keys={KEYS.addLink} />
              </MenuItem>
              <MenuItem onSelect={addSubIssue}>
                <LuListTree aria-hidden="true" className="h-3.5 w-3.5" />
                Add sub-issue
                <KeyHint keys={KEYS.addSubIssue} />
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
                  <KeyHint keys={command.keys} />
                </MenuItem>
              ))}
              <MenuSeparator />
            </>
          )}
          <MenuItem onSelect={copyIssueLink}>
            <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
            Copy link
          </MenuItem>
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
        keys={KEYS.addSubIssue}
        label="Add sub-issue"
        enabled={canAct}
        onRun={addSubIssue}
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
            <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8 lg:px-12 lg:py-10">
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
                statusOf={statusOf}
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
                hiddenIds={hiddenIds}
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

              <IssueSubscribers workspaceId={workspaceId} issueId={issue.id} />

              <p className="text-xs text-text-faint">
                Last updated {timestampLabel(issue.updated_at)}
              </p>
            </div>
          </aside>

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
          />
        </div>
      )}
    </WorkspaceShell>
  );
};

export default IssueDetail;
