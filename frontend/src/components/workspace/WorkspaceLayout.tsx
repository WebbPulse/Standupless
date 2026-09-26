/**
 * The layout route between the workspace provider and every page under
 * `/w/:slug`. Each page renders its own {@link WorkspaceShell}, so anything
 * that must outlive a page change lives here instead: the shortcut registry,
 * the command palette, the peek pane, the one create issue dialog, the create
 * team dialog, the shortcut help overlay, the shared team list and the one
 * toast stack every page raises notices into.
 *
 * Keeping these above the pages means a `g` pressed on one page completes on
 * the next, a palette opened anywhere is the same palette, and a dialog opened
 * from the sidebar does not close because the page underneath re-rendered.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
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
import { useAuth } from '../../hooks/useAuth';
import { CreateTeamContext } from '../../hooks/useCreateTeam';
import type { CreateTeamState } from '../../hooks/useCreateTeam';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canCreateTeam, canWriteIssues } from '../../lib/capabilities';
import { emptyFilters } from '../../lib/issueFilters';
import { showToast } from '../../lib/toast';
import TeamsProvider from '../../contexts/TeamsContext';
import { issuePath, routeTeamPrefix, teamPath } from '../../lib/paths';
import {
  issuesKey,
  labelsKey,
  statusesKey,
  teamMembersKey,
} from '../../lib/queryKeys';
import type { IssueRead, TeamRead } from '../../types/Api';
import CommandPalette from '../command/CommandPalette';
import CreateIssueDialog, {
  type CreateIssuePreset,
} from '../issues/CreateIssueDialog';
import GlobalShortcuts from '../shortcuts/GlobalShortcuts';
import ShortcutHelp from '../shortcuts/ShortcutHelp';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CreateTeamDialog from '../team/CreateTeamDialog';
import { Toaster } from '../ui/toast';
import { PeekProvider } from './PeekPane';

/** How often the dialog's supporting lists are re-read while it is open. */
const POLL_MS = 60000;

/** The open create request, with the team it resolved to. */
type Request = CreateIssueOptions & { teamId: string };

/** Props for the create issue host. */
interface CreateIssueHostProps {
  workspaceId: string;
  team: TeamRead;
  onClose: () => void;
  onCreated: (issue: IssueRead) => void;
  /** Runs for each issue made while the dialog stays open for another. */
  onCreatedMore: (issue: IssueRead) => void;
  /** The signed in person, listed first in the assignee picker. */
  currentUserId: string | undefined;
  /** What the caller asked the draft to start on. */
  preset: CreateIssuePreset;
}

/** The dialog preset a create request carries, leaving out what it does not set. */
const presetOf = (request: Request): CreateIssuePreset => ({
  ...(request.statusId === undefined ? {} : { statusId: request.statusId }),
  ...(request.assigneeId === undefined
    ? {}
    : { assigneeId: request.assigneeId }),
  ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
  ...(request.cycleId === undefined ? {} : { cycleId: request.cycleId }),
  ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
  ...(request.parentKey === undefined ? {} : { parentKey: request.parentKey }),
});

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
  onCreatedMore,
  currentUserId,
  preset,
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
      teamName={team.name}
      estimateScale={team.estimate_scale}
      statuses={statuses}
      labels={labels ?? []}
      people={people ?? []}
      onCreated={onCreated}
      onCreatedMore={onCreatedMore}
      {...(currentUserId === undefined ? {} : { currentUserId })}
      preset={preset}
      onClose={onClose}
    />
  );
};

/** Renders the overlays and the page beneath them, inside the team list. */
const WorkspaceOverlays: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const palette = useCommandPalette();
  const [helpOpen, setHelpOpen] = useState(false);
  const [request, setRequest] = useState<Request | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);

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

  const refreshLists = useCallback(
    (issue: IssueRead) => {
      invalidateQueries(issuesKey(workspaceId, issue.team_id, emptyFilters));
      invalidateQueries(issuesKey(workspaceId, 'mine', emptyFilters));
    },
    [workspaceId]
  );

  const onIssueCreatedMore = useCallback(
    (issue: IssueRead) => {
      refreshLists(issue);
      request?.onCreated?.(issue);
    },
    [refreshLists, request]
  );

  const onIssueCreated = useCallback(
    (issue: IssueRead) => {
      const held = request;
      setRequest(null);
      refreshLists(issue);
      showToast(`Created ${issue.key}`, 'info', {
        action: { label: 'Open', to: issuePath(slug, issue.key) },
      });
      held?.onCreated?.(issue);
    },
    [request, refreshLists, slug]
  );

  const onTeamCreated = useCallback(
    (team: TeamRead, warning?: string) => {
      setCreatingTeam(false);
      showToast(warning ?? `Created ${team.name}.`);
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
              <Toaster />
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
                  onCreatedMore={onIssueCreatedMore}
                  currentUserId={user?.id}
                  preset={presetOf(request)}
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
            </PeekProvider>
          </CreateTeamContext.Provider>
        </CreateIssueContext.Provider>
      </CommandPaletteContext.Provider>
    </ShortcutProvider>
  );
};

/** Provides the shared team list and the workspace-wide overlays. */
export const WorkspaceLayout: React.FC = () => (
  <TeamsProvider>
    <WorkspaceOverlays />
  </TeamsProvider>
);

export default WorkspaceLayout;
