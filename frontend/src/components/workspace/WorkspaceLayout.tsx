/**
 * The layout route between the workspace provider and every page under
 * `/w/:slug`. Each page renders its own {@link WorkspaceShell}, so anything
 * that must outlive a page change lives here instead: the shortcut registry,
 * the command palette, the peek pane, the one create issue dialog, the create
 * team dialog, the shortcut help overlay and the notice a create leaves.
 *
 * Keeping these above the pages means a `g` pressed on one page completes on
 * the next, a palette opened anywhere is the same palette, and a dialog opened
 * from the sidebar does not close because the page underneath re-rendered.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { LuX } from 'react-icons/lu';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { listLabels, listStatuses, listTeamMembers } from '../../api/teams';
import {
  CommandPaletteContext,
  useCommandPalette,
} from '../../hooks/useCommandPalette';
import { CreateIssueContext } from '../../hooks/useCreateIssue';
import type {
  CreateIssueOptions,
  CreateIssueState,
} from '../../hooks/useCreateIssue';
import { CreateTeamContext } from '../../hooks/useCreateTeam';
import type { CreateTeamState } from '../../hooks/useCreateTeam';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canCreateTeam, canWriteIssues } from '../../lib/capabilities';
import { emptyFilters } from '../../lib/issueFilters';
import { issuePath, routeTeamPrefix, teamPath } from '../../lib/paths';
import {
  issuesKey,
  labelsKey,
  statusesKey,
  teamMembersKey,
} from '../../lib/queryKeys';
import type { IssueRead, TeamRead } from '../../types/Api';
import CommandPalette from '../command/CommandPalette';
import CreateIssueDialog from '../issues/CreateIssueDialog';
import GlobalShortcuts from '../shortcuts/GlobalShortcuts';
import ShortcutHelp from '../shortcuts/ShortcutHelp';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CreateTeamDialog from '../team/CreateTeamDialog';
import { IconButton } from '../ui/button';
import { PeekProvider } from './PeekPane';

/** How often the dialog's supporting lists are re-read while it is open. */
const POLL_MS = 60000;

/** How long a notice stays before it clears itself, in ms. */
const NOTICE_MS = 8000;

/** A short confirmation left after a create, with a link to what was made. */
interface Notice {
  id: number;
  text: string;
  link?: { to: string; label: string };
}

/** The open create request, with the team it resolved to. */
type Request = CreateIssueOptions & { teamId: string };

/** Props for the notice toast. */
interface NoticeToastProps {
  notice: Notice;
  onDismiss: () => void;
}

/** A dismissible confirmation in the bottom corner, announced politely. */
const NoticeToast: React.FC<NoticeToastProps> = ({ notice, onDismiss }) => {
  useEffect(() => {
    const timer = globalThis.setTimeout(onDismiss, NOTICE_MS);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [notice.id, onDismiss]);

  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-40 flex max-w-sm items-center gap-3 rounded-md border border-line bg-overlay py-2 pr-2 pl-3 text-sm shadow-overlay"
    >
      <span className="min-w-0 flex-1">
        {notice.text}
        {notice.link !== undefined && (
          <>
            {' '}
            <Link
              to={notice.link.to}
              className="font-medium text-accent hover:underline"
              onClick={onDismiss}
            >
              {notice.link.label}
            </Link>
          </>
        )}
      </span>
      <IconButton label="Dismiss" size="sm" onClick={onDismiss}>
        <LuX className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
};

/** Props for the create issue host. */
interface CreateIssueHostProps {
  workspaceId: string;
  team: TeamRead;
  onClose: () => void;
  onCreated: (issue: IssueRead) => void;
}

/**
 * Loads the chosen team's statuses, labels and people and renders the dialog
 * once the statuses are in, so it never opens on a status list that is about
 * to change under the person typing.
 */
const CreateIssueHost: React.FC<CreateIssueHostProps> = ({
  workspaceId,
  team,
  onClose,
  onCreated,
}) => {
  const auth = useQueryAuth();
  const { data: statuses } = usePolledQuery(
    ({ signal }) => listStatuses(workspaceId, team.id, signal),
    { intervalMs: POLL_MS, queryKey: statusesKey(team.id), auth }
  );
  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, team.id, signal),
    { intervalMs: POLL_MS, queryKey: labelsKey(team.id), auth }
  );
  const { data: people } = usePolledQuery(
    ({ signal }) => listTeamMembers(workspaceId, team.id, signal),
    { intervalMs: POLL_MS, queryKey: teamMembersKey(team.id), auth }
  );

  if (statuses === null) return null;

  return (
    <CreateIssueDialog
      key={team.id}
      workspaceId={workspaceId}
      teamId={team.id}
      estimateScale={team.estimate_scale}
      statuses={statuses}
      labels={labels ?? []}
      people={people ?? []}
      onCreated={onCreated}
      onClose={onClose}
    />
  );
};

/** Provides the workspace-wide overlays and renders the page beneath them. */
export const WorkspaceLayout: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const location = useLocation();
  const navigate = useNavigate();
  const palette = useCommandPalette();
  const [helpOpen, setHelpOpen] = useState(false);
  const [request, setRequest] = useState<Request | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const role = workspace?.role;

  const writable = useMemo(
    () => teams.filter((team) => canWriteIssues(role, team.role)),
    [teams, role]
  );
  const routePrefix = routeTeamPrefix(location.pathname, location.search);

  const openCreateIssue = useCallback(
    (options: CreateIssueOptions = {}) => {
      const team =
        (options.teamId === undefined
          ? undefined
          : writable.find((row) => row.id === options.teamId)) ??
        writable.find((row) => row.key_prefix === routePrefix) ??
        writable[0];
      if (team === undefined) return;
      setRequest({ ...options, teamId: team.id });
    },
    [writable, routePrefix]
  );

  const closeCreateIssue = useCallback(() => {
    setRequest(null);
  }, []);

  const createIssue = useMemo<CreateIssueState>(
    () => ({
      open: openCreateIssue,
      close: closeCreateIssue,
      isOpen: request !== null,
      canCreate: writable.length > 0,
      request,
    }),
    [openCreateIssue, closeCreateIssue, request, writable.length]
  );

  const mayCreateTeam = canCreateTeam(role);
  const createTeam = useMemo<CreateTeamState>(
    () => ({
      open: () => {
        if (mayCreateTeam) setCreatingTeam(true);
      },
      canCreate: mayCreateTeam,
    }),
    [mayCreateTeam]
  );

  const dismissNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const onIssueCreated = useCallback(
    (issue: IssueRead) => {
      const held = request;
      setRequest(null);
      invalidateQueries(issuesKey(workspaceId, issue.team_id, emptyFilters));
      invalidateQueries(issuesKey(workspaceId, 'mine', emptyFilters));
      setNotice({
        id: Date.now(),
        text: 'Created',
        link: { to: issuePath(slug, issue.key), label: issue.key },
      });
      held?.onCreated?.(issue);
    },
    [request, workspaceId, slug]
  );

  const onTeamCreated = useCallback(
    (team: TeamRead, warning?: string) => {
      setCreatingTeam(false);
      setNotice({
        id: Date.now(),
        text: warning ?? `Created ${team.name}.`,
      });
      void navigate(teamPath(slug, team.key_prefix));
    },
    [navigate, slug]
  );

  const requestTeam =
    request === null
      ? undefined
      : teams.find((team) => team.id === request.teamId);

  const showHelp = useCallback(() => {
    setHelpOpen(true);
  }, []);

  return (
    <ShortcutProvider>
      <CommandPaletteContext.Provider value={palette}>
        <CreateIssueContext.Provider value={createIssue}>
          <CreateTeamContext.Provider value={createTeam}>
            <PeekProvider>
              <Outlet />

              {workspace !== null && (
                <>
                  <GlobalShortcuts
                    workspace={workspace}
                    teams={teams}
                    onShowHelp={showHelp}
                  />
                  <CommandPalette
                    open={palette.open}
                    onClose={palette.closePalette}
                    workspace={workspace}
                    teams={teams}
                    onShowShortcuts={showHelp}
                  />
                </>
              )}

              <ShortcutHelp
                open={helpOpen}
                onClose={() => {
                  setHelpOpen(false);
                }}
              />

              {request !== null && requestTeam !== undefined && (
                <CreateIssueHost
                  workspaceId={workspaceId}
                  team={requestTeam}
                  onClose={closeCreateIssue}
                  onCreated={onIssueCreated}
                />
              )}

              {creatingTeam && workspaceId !== '' && (
                <CreateTeamDialog
                  workspaceId={workspaceId}
                  onClose={() => {
                    setCreatingTeam(false);
                  }}
                  onCreated={onTeamCreated}
                />
              )}

              {notice !== null && (
                <NoticeToast notice={notice} onDismiss={dismissNotice} />
              )}
            </PeekProvider>
          </CreateTeamContext.Provider>
        </CreateIssueContext.Provider>
      </CommandPaletteContext.Provider>
    </ShortcutProvider>
  );
};

export default WorkspaceLayout;
