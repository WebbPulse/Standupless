/**
 * The layout route between the workspace provider and every page under
 * `/w/:slug`. Each page renders its own {@link WorkspaceShell}, so anything
 * that must outlive a page change lives here instead: the shortcut registry,
 * the command palette, the peek pane, the one create issue dialog, the create
 * team dialog, the create project and initiative dialogs, the shortcut help overlay, the shared team list, the mention
 * directory and the one toast stack every page raises notices into.
 *
 * It also records the workspace as the one this browser last opened, which
 * the home page resumes for a signed in visitor.
 *
 * Keeping these above the pages means a `g` pressed on one page completes on
 * the next, a palette opened anywhere is the same palette, and a dialog opened
 * from the sidebar does not close because the page underneath re-rendered.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  clearPolledQueryCache,
  invalidateQueries,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { listLabels, listStatuses, listTeamMembers } from '../../api/teams';
import {
  CommandPaletteContext,
  useCommandPalette,
} from '../../hooks/useCommandPalette';
import { CreateIssueContext } from '../../hooks/useCreateIssue';
import { useHasIssueDraft } from '../../lib/issueDraft';
import type {
  CreateIssueOptions,
  CreateIssueState,
} from '../../hooks/useCreateIssue';
import { useAuth } from '../../hooks/useAuth';
import { CreateTeamContext } from '../../hooks/useCreateTeam';
import {
  CustomizeSidebarContext,
  type CustomizeSidebarState,
} from '../../hooks/useCustomizeSidebar';
import type { CreateTeamState } from '../../hooks/useCreateTeam';
import { CreatePlanningContext } from '../../hooks/useCreatePlanning';
import { usePublishCustomEmoji } from '../../hooks/useCustomEmojiList';
import type { CreatePlanningState } from '../../hooks/useCreatePlanning';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canCreateTeam, canWriteIssues } from '../../lib/capabilities';
import { emptyFilters } from '../../lib/issueFilters';
import { rememberWorkspace } from '../../lib/lastWorkspace';
import { showToast } from '../../lib/toast';
import MentionDirectoryProvider from '../../contexts/MentionDirectoryContext';
import SidebarDataProvider from '../../contexts/SidebarDataContext';
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
import RouteErrorBoundary, {
  RouteErrorState,
  type RouteErrorFallbackProps,
} from '../routes/RouteErrorBoundary';
import CreateIssueDialog, {
  type CreateIssuePreset,
} from '../issues/CreateIssueDialog';
import GlobalShortcuts from '../shortcuts/GlobalShortcuts';
import ShortcutHelp from '../shortcuts/ShortcutHelp';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CreateTeamDialog from '../team/CreateTeamDialog';
import CreatePlanningHost, {
  type PlanningDialog,
} from '../planning/CreatePlanningHost';
import DesktopInboxReporter from '../desktop/DesktopInboxReporter';
import { Toaster } from '../ui/toast';
import CustomizeSidebarDialog from './CustomizeSidebarDialog';
import { PeekProvider } from './PeekPane';
import WorkspaceShell from './WorkspaceShell';
import { estimateOptionsOf } from '../../lib/validation';
import { LOOKUP_POLL_MS } from '../../lib/polling';

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
  ...(request.templateId === undefined
    ? {}
    : { templateId: request.templateId }),
  ...(request.title === undefined ? {} : { title: request.title }),
  ...(request.description === undefined
    ? {}
    : { description: request.description }),
  ...(request.relatedIssueId === undefined
    ? {}
    : { relatedIssueId: request.relatedIssueId }),
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
    (context) => listStatuses(workspaceId, team.id, context),
    { intervalMs: LOOKUP_POLL_MS, queryKey: statusesKey(team.id), auth }
  );
  const { data: labels } = usePolledQuery(
    (context) => listLabels(workspaceId, team.id, context),
    { intervalMs: LOOKUP_POLL_MS, queryKey: labelsKey(team.id), auth }
  );
  const { data: people } = usePolledQuery(
    (context) => listTeamMembers(workspaceId, team.id, context),
    { intervalMs: LOOKUP_POLL_MS, queryKey: teamMembersKey(team.id), auth }
  );

  if (statuses === null) return null;

  return (
    <CreateIssueDialog
      key={team.id}
      workspaceId={workspaceId}
      teamId={team.id}
      teamName={team.name}
      estimateScale={team.estimate_scale}
      estimateOptions={estimateOptionsOf(team)}
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

/** The workspace this tab last showed, kept across layout remounts. */
let shownWorkspaceId = '';

/**
 * Empties the shared polled query cache when the person moves from one
 * workspace to another, including by way of the workspace list, which unmounts
 * this layout. Keys such as a team's statuses, labels, members and templates
 * are not workspace scoped, so the old workspace's lists are dropped rather
 * than kept warm. Queries already mounted keep what they show until their next
 * read.
 */
const useWorkspaceSwitchCacheClear = (workspaceId: string): void => {
  useEffect(() => {
    if (workspaceId === '' || workspaceId === shownWorkspaceId) return;
    const left = shownWorkspaceId;
    shownWorkspaceId = workspaceId;
    if (left !== '') clearPolledQueryCache();
  }, [workspaceId]);
};

/**
 * What a page that threw shows instead: the error inside the workspace frame,
 * so the sidebar stays usable and leads somewhere that works.
 */
const WorkspaceRouteError: React.FC<RouteErrorFallbackProps> = (props) => (
  <WorkspaceShell title="Something went wrong">
    <RouteErrorState {...props} />
  </WorkspaceShell>
);

/** Renders the overlays and the page beneath them, inside the team list. */
const WorkspaceOverlays: React.FC = () => {
  const { workspace, workspaces } = useWorkspace();
  const { teams } = useTeam(undefined);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const palette = useCommandPalette();
  const [helpOpen, setHelpOpen] = useState(false);
  const [request, setRequest] = useState<Request | null>(null);
  const [creatingTeam, setCreatingTeam] = useState<{
    parentTeamId: string | null;
  } | null>(null);
  const [planning, setPlanning] = useState<PlanningDialog>(null);
  const [customizing, setCustomizing] = useState(false);
  const customizeSidebar = useMemo<CustomizeSidebarState>(
    () => ({
      open: () => {
        setCustomizing(true);
      },
    }),
    []
  );

  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const role = workspace?.role;

  useEffect(() => {
    rememberWorkspace(slug);
  }, [slug]);
  useWorkspaceSwitchCacheClear(workspaceId);
  usePublishCustomEmoji(workspaceId);

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

  const hasDraft = useHasIssueDraft(workspaceId, user?.id);

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
      hasDraft,
    }),
    [openCreateIssue, closeCreateIssue, request, writable.length, hasDraft]
  );

  const mayCreateTeam = canCreateTeam(role);
  const createTeam = useMemo<CreateTeamState>(
    () => ({
      open: () => {
        if (mayCreateTeam) setCreatingTeam({ parentTeamId: null });
      },
      openSubTeam: (parentTeamId: string) => {
        if (mayCreateTeam) setCreatingTeam({ parentTeamId });
      },
      canCreate: mayCreateTeam,
    }),
    [mayCreateTeam]
  );

  const mayCreateProject = writable.length > 0;
  const mayCreateInitiative = role !== undefined && role !== 'guest';
  const createPlanning = useMemo<CreatePlanningState>(
    () => ({
      openProject: () => {
        if (mayCreateProject) setPlanning('project');
      },
      openInitiative: () => {
        if (mayCreateInitiative) setPlanning('initiative');
      },
      canCreateProject: mayCreateProject,
      canCreateInitiative: mayCreateInitiative,
    }),
    [mayCreateProject, mayCreateInitiative]
  );
  const closePlanning = useCallback(() => {
    setPlanning(null);
  }, []);

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
      setCreatingTeam(null);
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
            <CustomizeSidebarContext.Provider value={customizeSidebar}>
              <CreatePlanningContext.Provider value={createPlanning}>
                <MentionDirectoryProvider workspaceId={workspaceId}>
                  <PeekProvider>
                    <Toaster />
                    <RouteErrorBoundary fallback={WorkspaceRouteError}>
                      <Outlet />
                    </RouteErrorBoundary>

                    {workspace !== null && (
                      <>
                        <DesktopInboxReporter
                          workspaceId={workspace.id}
                          slug={workspace.slug}
                        />
                        <GlobalShortcuts
                          workspace={workspace}
                          teams={teams}
                          onShowHelp={showHelp}
                        />
                        <CommandPalette
                          open={palette.open}
                          onClose={palette.closePalette}
                          picker={palette.picker}
                          workspace={workspace}
                          teams={teams}
                          onShowShortcuts={showHelp}
                          currentUserId={user?.id}
                          workspaces={workspaces ?? []}
                          onLogOut={() => void logout()}
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

                    {creatingTeam !== null && workspaceId !== '' && (
                      <CreateTeamDialog
                        workspaceId={workspaceId}
                        teams={teams}
                        initialParentTeamId={creatingTeam.parentTeamId}
                        onClose={() => {
                          setCreatingTeam(null);
                        }}
                        onCreated={onTeamCreated}
                      />
                    )}

                    <CustomizeSidebarDialog
                      open={customizing}
                      role={role}
                      onClose={() => {
                        setCustomizing(false);
                      }}
                    />

                    <CreatePlanningHost
                      open={planning}
                      workspaceId={workspaceId}
                      slug={slug}
                      writableTeams={writable}
                      routePrefix={routePrefix}
                      currentUserId={user?.id}
                      onClose={closePlanning}
                    />
                  </PeekProvider>
                </MentionDirectoryProvider>
              </CreatePlanningContext.Provider>
            </CustomizeSidebarContext.Provider>
          </CreateTeamContext.Provider>
        </CreateIssueContext.Provider>
      </CommandPaletteContext.Provider>
    </ShortcutProvider>
  );
};

/** Provides the shared team list, the sidebar's reads and the workspace-wide overlays. */
export const WorkspaceLayout: React.FC = () => (
  <TeamsProvider>
    <SidebarDataProvider>
      <WorkspaceOverlays />
    </SidebarDataProvider>
  </TeamsProvider>
);

export default WorkspaceLayout;
