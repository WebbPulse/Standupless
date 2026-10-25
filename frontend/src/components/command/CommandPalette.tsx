/**
 * The command palette: one input over one list, holding what a person can do
 * right now, the places they can go and the issues a term matches.
 *
 * Actions, destinations and search results share a list rather than sitting in
 * separate panes, because the person typing does not know yet which of the
 * three their term is going to be, and a single highlight that Enter always
 * resolves is the whole point of the surface.
 *
 * The actions on the issue in focus are not declared here. They are whatever
 * the page registered in the `'issue'` shortcut scope, run through the same
 * registry the keys use, so an action a page adds is reachable by name without
 * the palette knowing about it. Actions on a page that is not an issue, such
 * as a project, come the same way from the `'page'` scope, listed under the
 * group each registered with, once each even when two keys run them.
 *
 * Every settings page and the current team's settings sections are listed
 * once a term is typed, matched on the words in {@link settingsDestinations}
 * as well as their names, so "notifications" or "sla" lands on the page that
 * holds them. Creating a project or an initiative opens the workspace's one
 * dialog for each over the page in view, and a project or initiative page adds
 * its own "Create document".
 *
 * The favorite, project, cycle, team, view, member, template and workspace pickers
 * are nested lists a row opens, and the `O` then letter shortcuts and Alt+C
 * open the palette straight onto one of them through the `picker` prop. A
 * team with no templates offers a row to its template settings instead. The
 * workspace picker leaves out the workspace in view and ends on Create
 * workspace, and Log out sits among the actions.
 *
 * Every list ranks its rows by the deterministic fuzzy scorer in
 * {@link rankRows}, so abbreviations and small typos still land, the closest
 * match leads its section, and the matched characters are drawn brighter.
 *
 * An exact issue key resolves without the index, the same way the search page
 * does, since the index does not hold keys and a key is the most common thing
 * anyone types here.
 *
 * The issues the viewer opened most recently in this workspace head the top
 * level, so an empty palette is one Enter away from the issue seen a minute
 * ago, and a typed term narrows them along with everything else. With an issue
 * in view its own actions come first and the recent issues follow them, so
 * Enter runs the first action rather than leaving the issue.
 *
 * With issues in focus a typed term also matches the values their properties
 * can take, as Linear does, so "urgent" offers "Set priority to Urgent" and a
 * teammate's name offers "Assign to" them. The values come from the page that
 * published the subject and write through its pickers, so the undo is the
 * pickers' own. They follow the commands that matched, values whose name
 * starts with the term first, and only the first few are listed.
 */

import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LuActivity,
  LuArchive,
  LuArrowLeftRight,
  LuArrowRight,
  LuBot,
  LuBuilding2,
  LuChevronLeft,
  LuCircleDot,
  LuDoorOpen,
  LuFileText,
  LuGitPullRequest,
  LuGoal,
  LuInbox,
  LuKeyboard,
  LuLayers,
  LuLayoutList,
  LuLink,
  LuList,
  LuLogOut,
  LuMap,
  LuMaximize2,
  LuMonitor,
  LuMoon,
  LuPlus,
  LuRefreshCcw,
  LuRocket,
  LuSearch,
  LuSettings,
  LuSlidersHorizontal,
  LuSquareKanban,
  LuSquarePen,
  LuStar,
  LuSun,
  LuTarget,
  LuTerminal,
  LuTrash2,
  LuUndo2,
  LuUserRound,
  LuUsers,
  LuUsersRound,
  LuZap,
} from 'react-icons/lu';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { listWorkspaceDocuments } from '../../api/documents';
import { listFavorites } from '../../api/favorites';
import { listCycles, listProjects } from '../../api/planning';
import { listStatuses } from '../../api/teams';
import { listTeamTemplates } from '../../api/templates';
import { listViews, search } from '../../api/views';
import ViewIcon from '../views/ViewIcon';
import { StatusIcon } from '../ui/StatusIcon';
import {
  CREATE_FROM_TEMPLATE_KEYS,
  CREATE_FULLSCREEN_KEYS,
  useCreateIssue,
} from '../../hooks/useCreateIssue';
import { useCreatePlanning } from '../../hooks/useCreatePlanning';
import { useCustomizeSidebar } from '../../hooks/useCustomizeSidebar';
import { useLeaveWorkspace } from '../../hooks/useLeaveWorkspace';
import { useCreateTeam } from '../../hooks/useCreateTeam';
import type { PalettePicker } from '../../hooks/useCommandPalette';
import { LOG_OUT_KEYS } from '../../lib/logOut';
import { useIssueSubject } from '../../hooks/useIssueSubject';
import { displayKeys, useRegisteredShortcuts } from '../../hooks/useShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { UNDO_KEYS, UNDO_LABEL, useUndo } from '../../hooks/useUndo';
import { cn } from '../../lib/cn';
import {
  NEW_WORKSPACE_PATH,
  accountSecuritySettingsPath,
  cliSetupPath,
  customersPath,
  cyclePath,
  documentPath,
  inboxPath,
  initiativesPath,
  issuePath,
  mcpSetupPath,
  memberPath,
  myIssuesPath,
  newViewPath,
  preferencesSettingsPath,
  projectPath,
  projectsPath,
  profileSettingsPath,
  pulsePath,
  reviewsPath,
  roadmapPath,
  routeIssueKey,
  routeTeamPrefix,
  searchPath,
  settingsTeamsPath,
  viewPath,
  teamArchivePath,
  teamTrashPath,
  teamBoardPath,
  teamCyclesPath,
  teamPath,
  teamReleasesPath,
  teamViewsPath,
  teamSettingsPath,
  teamSettingsSectionPath,
  teamTriagePath,
  viewsPath,
} from '../../lib/paths';
import { COPY_ISSUE_URL_KEYS } from '../../lib/copyIssue';
import { favoriteHref } from '../../lib/favorites';
import { homeViewPath } from '../../lib/preferences';
import { isFormTemplate } from '../../lib/issueTemplates';
import ProjectIcon from '../planning/ProjectIcon';
import DocumentIcon from '../planning/DocumentIcon';
import { fuzzyMatch, rankRows, type MatchRange } from '../../lib/fuzzyMatch';
import {
  settingsDestinations,
  teamSettingsDestinations,
} from '../../lib/paletteDestinations';
import {
  cyclesKey,
  favoritesKey,
  projectsKey,
  searchKey,
  statusesKey,
  templatesKey,
  viewsKey,
  workspaceDocumentsKey,
} from '../../lib/queryKeys';
import {
  hasIndexableTerm,
  isIssueKey,
  isPartialIssueKey,
  MIN_TERM,
} from '../../lib/searchTerms';
import { readRecentIssues, type RecentIssue } from '../../lib/recentIssues';
import { teamTree } from '../../lib/teamOrder';
import { activeTeams } from '../../lib/teamRetirement';
import { TRIAGE_STATUS } from '../../lib/triageStatus';
import { teamScopePath } from '../../lib/teamIssueScope';
import type { Theme } from '../../lib/theme';
import {
  currentOrFirstTeam,
  routeTeam,
  settingsLanding,
} from '../../lib/workspaceNav';
import { openUpcomingCycle } from '../../lib/currentCycle';
import type {
  CycleRead,
  MemberRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import { LOOKUP_POLL_MS } from '../../lib/polling';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';

/** How many hits the palette asks the search route for. */
const RESULT_LIMIT = 20;

/** How many documents a term lists, since the rest are a narrower term away. */
const DOCUMENT_LIMIT = 8;

/** How many property values a term lists, since the rest are a narrower term away. */
const VALUE_LIMIT = 8;

/** How often an open search re-reads while its term is unchanged. */
const POLL_MS = 60000;

/** Props for CommandPalette. */
export interface CommandPaletteProps {
  /** Whether the palette is showing. */
  open: boolean;
  /** Called when the palette should close, on Escape, backdrop or activation. */
  onClose: () => void;
  /** The workspace every route and read is built from. */
  workspace: Pick<WorkspaceRead, 'id' | 'slug' | 'role'>;
  /** The teams the caller can see; retired ones are left out of every list. */
  teams?: readonly TeamRead[];
  /** Opens the keyboard shortcut overlay. */
  onShowShortcuts?: () => void;
  /** The picker to open on instead of the top level, or null for the top level. */
  picker?: PalettePicker | null;
  /** The viewer, whose recently opened issues head the top level. */
  currentUserId?: string | undefined;
  /** Every workspace the viewer belongs to, for Switch workspace. */
  workspaces?: readonly Pick<WorkspaceRead, 'id' | 'slug' | 'name'>[];
  /** Signs the viewer out. Without it no Log out row shows. */
  onLogOut?: () => void;
}

/**
 * One row of the palette. A row either goes somewhere (`to`) or does
 * something (`run`), and a row with `page` opens a nested list instead.
 */
interface Command {
  id: string;
  label: string;
  /** Extra words the row matches on without showing them. */
  keywords?: string;
  /** A key, a shortcut or a team prefix shown at the end of the row. */
  hint?: string;
  icon: React.ReactNode;
  to?: string;
  run?: () => void;
  page?: Page;
  /** Draws the row one step in, as a sub-team under its parent. */
  indent?: boolean;
  /** The label characters the typed term matched, for highlighting. */
  ranges?: readonly MatchRange[];
}

/** A run of commands under one heading. */
interface CommandGroup {
  heading: string;
  commands: Command[];
}

/**
 * The palette's lists: the top level, or the favorite, project, cycle, team,
 * view, sub-team parent or issue template picker inside it.
 */
type Page = 'root' | PalettePicker | 'sub-team';

/** What the back button and the input say on each nested list. */
const PAGE_COPY: Record<
  Exclude<Page, 'root'>,
  { back: string; placeholder: string }
> = {
  teams: { back: 'Switch team', placeholder: 'Switch to a team' },
  workspaces: {
    back: 'Switch workspace',
    placeholder: 'Switch to a workspace',
  },
  views: { back: 'Open view', placeholder: 'Open a saved view' },
  favorites: { back: 'Open favorite', placeholder: 'Open a favorite' },
  projects: { back: 'Open project', placeholder: 'Open a project' },
  cycles: { back: 'Open cycle', placeholder: 'Open a cycle' },
  members: { back: 'Open member', placeholder: 'Open a member' },
  'sub-team': {
    back: 'Create sub-team',
    placeholder: 'Pick the parent team',
  },
  template: {
    back: 'Create issue from template',
    placeholder: 'Pick a template',
  },
};

/**
 * How a member reads in the palette: their handle, then their written name.
 * Never their email, matching the member page.
 */
const memberName = (member: MemberRead): string =>
  member.display_name ??
  (member.full_name !== undefined && member.full_name !== ''
    ? member.full_name
    : 'Member');

/** Whether a team sits at the top level, so it can take a sub-team. */
const isTopLevel = (team: TeamRead): boolean =>
  team.parent_team_id === null || team.parent_team_id === undefined;

const ICON = 'h-3.5 w-3.5 shrink-0';

/** The words a theme setting reads as, and the icon it shows. */
const THEMES: { theme: Theme; label: string; icon: React.ReactNode }[] = [
  {
    theme: 'dark',
    label: 'Switch to dark theme',
    icon: <LuMoon className={ICON} />,
  },
  {
    theme: 'light',
    label: 'Switch to light theme',
    icon: <LuSun className={ICON} />,
  },
  {
    theme: 'system',
    label: 'Use system theme',
    icon: <LuMonitor className={ICON} />,
  },
];

/** The order cycles list in: the current one, then upcoming, then the rest. */
const CYCLE_RANK: Record<CycleRead['status'], number> = {
  active: 0,
  upcoming: 1,
  completed: 2,
  cancelled: 3,
};

/** How a cycle's status reads as a row hint. */
const CYCLE_HINT: Record<CycleRead['status'], string> = {
  active: 'Current',
  upcoming: 'Upcoming',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * A team's cycles in picker order: current first, upcoming soonest first,
 * then completed and cancelled ones most recent first.
 */
const pickerCycles = (cycles: readonly CycleRead[]): CycleRead[] =>
  [...cycles].sort((left, right) => {
    const rank = CYCLE_RANK[left.status] - CYCLE_RANK[right.status];
    if (rank !== 0) return rank;
    const dates = left.start_date.localeCompare(right.start_date);
    return left.status === 'upcoming' || left.status === 'active'
      ? dates
      : -dates;
  });

/** A recently opened issue's status glyph, read from its team's statuses. */
const RecentIssueIcon: React.FC<{
  workspaceId: string;
  issue: RecentIssue;
}> = ({ workspaceId, issue }) => {
  const auth = useQueryAuth();
  const { data: statuses } = usePolledQuery(
    (context) => listStatuses(workspaceId, issue.team_id, context),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: workspaceId !== '' && issue.team_id !== '',
      queryKey: statusesKey(issue.team_id),
      auth,
    }
  );
  const known = statuses ?? [];
  const status =
    issue.in_triage === true
      ? TRIAGE_STATUS
      : known.find((row) => row.id === issue.status_id);
  return <StatusIcon status={status} statuses={known} className={ICON} />;
};

/** A shortcut as a row hint, such as "G then I". */
const shortcutHint = (keys: string): string =>
  displayKeys(keys).join(keys.includes(' ') ? ' then ' : ' ');

/**
 * Ranks commands against the typed term, best first, dropping those that do
 * not match. The label is scored first, then the hint and keywords, and each
 * kept command carries the label characters that matched for highlighting.
 */
const rank = (commands: readonly Command[], term: string): Command[] =>
  rankRows(
    commands,
    term,
    (command) => command.label,
    (command) => [command.hint ?? '', command.keywords ?? '']
  ).map(({ row, match }) =>
    match.ranges.length === 0 ? row : { ...row, ranges: match.ranges }
  );

/** A label with the characters the term matched drawn brighter. */
const HighlightedLabel: React.FC<{
  label: string;
  ranges: readonly MatchRange[] | undefined;
}> = ({ label, ranges }) => {
  if (ranges === undefined || ranges.length === 0) return <>{label}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start >= label.length) break;
    if (start > at) parts.push(label.slice(at, start));
    parts.push(
      <span key={start} className="font-medium text-text">
        {label.slice(start, Math.min(end, label.length))}
      </span>
    );
    at = Math.min(end, label.length);
  }
  if (at < label.length) parts.push(label.slice(at));
  return <>{parts}</>;
};

/**
 * The same page under another team: a team route keeps its tab, anything else
 * lands on the team's issues.
 */
const switchTeamPath = (
  pathname: string,
  slug: string,
  from: string | null,
  to: string
): string => {
  const base = from === null ? null : teamPath(slug, from);
  if (base !== null && (pathname === base || pathname.startsWith(`${base}/`))) {
    return `${teamPath(slug, to)}${pathname.slice(base.length)}`;
  }
  return teamPath(slug, to);
};

/**
 * The open palette. It mounts on open and unmounts on close, so every opening
 * starts on an empty term at the top level without resetting state by hand.
 */
const PaletteBody: React.FC<Omit<CommandPaletteProps, 'open'>> = ({
  onClose,
  workspace,
  teams: visibleTeams = [],
  onShowShortcuts,
  picker = null,
  currentUserId,
  workspaces,
  onLogOut,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useQueryAuth();
  const teams = useMemo(() => activeTeams(visibleTeams), [visibleTeams]);
  const createIssue = useCreateIssue();
  const createTeam = useCreateTeam();
  const createPlanning = useCreatePlanning();
  const customizeSidebar = useCustomizeSidebar();
  const leaveWorkspace = useLeaveWorkspace();
  const { theme, setTheme } = useTheme();
  const registered = useRegisteredShortcuts();
  const { canUndo, undo } = useUndo(workspace.id);
  const subject = useIssueSubject();
  const [term, setTerm] = useState('');
  const [page, setPage] = useState<Page>(picker ?? 'root');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const titleId = useId();

  const workspaceId = workspace.id;
  const slug = workspace.slug;
  const [recents] = useState(() =>
    readRecentIssues(workspaceId, currentUserId)
  );
  const routePrefix = routeTeamPrefix(location.pathname, location.search);
  const issueKey = routeIssueKey(location.pathname);
  const team = currentOrFirstTeam(teams, routePrefix);
  const insideTeam = routeTeam(teams, routePrefix) !== undefined;

  const deferred = useDeferredValue(term).trim();
  const isKey = page === 'root' && isIssueKey(deferred);
  const isPartialKey = isPartialIssueKey(deferred);
  const indexable = hasIndexableTerm(deferred);
  const enabled =
    page === 'root' &&
    workspaceId !== '' &&
    deferred !== '' &&
    indexable &&
    !isKey &&
    !isPartialKey;

  const { data, isLoading } = usePolledQuery(
    ({ signal }) =>
      search(workspaceId, deferred, { limit: RESULT_LIMIT }, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: searchKey(workspaceId, deferred, ''),
      auth,
    }
  );

  const { data: documents } = usePolledQuery(
    ({ signal }) => listWorkspaceDocuments(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: page === 'root' && workspaceId !== '' && deferred !== '',
      queryKey: workspaceDocumentsKey(workspaceId),
      auth,
    }
  );

  const members = useWorkspaceMembers(
    workspaceId,
    (page === 'root' && deferred !== '') || page === 'members'
  );

  const { data: savedViews } = usePolledQuery(
    (context) => listViews(workspaceId, { scope: 'all' }, context),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: page === 'views' && workspaceId !== '',
      queryKey: viewsKey(workspaceId, 'all', ''),
      auth,
    }
  );

  const { data: favorites } = usePolledQuery(
    ({ signal }) => listFavorites(workspaceId, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: page === 'favorites' && workspaceId !== '',
      queryKey: favoritesKey(workspaceId),
      auth,
    }
  );

  const { data: projectList } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, {}, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: page === 'projects' && workspaceId !== '',
      queryKey: [...projectsKey(workspaceId, '', ''), 'palette'],
      auth,
    }
  );

  const { data: cycleList } = usePolledQuery(
    ({ signal }) =>
      listCycles(workspaceId, { team_id: team?.id ?? '' }, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: page === 'cycles' && workspaceId !== '' && team !== undefined,
      queryKey: [...cyclesKey(workspaceId, team?.id ?? '', ''), 'palette'],
      auth,
    }
  );

  const { data: templateList } = usePolledQuery(
    ({ signal }) => listTeamTemplates(workspaceId, team?.id ?? '', signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: page === 'template' && workspaceId !== '' && team !== undefined,
      queryKey: [...templatesKey(team?.id ?? ''), 'palette'],
      auth,
    }
  );

  const pageActions = useMemo<CommandGroup[]>(() => {
    const byGroup = new Map<string, Command[]>();
    for (const shortcut of registered) {
      if (shortcut.scope !== 'page') continue;
      const rows = byGroup.get(shortcut.group) ?? [];
      if (rows.some((row) => row.label === shortcut.label)) continue;
      rows.push({
        id: `page-action-${shortcut.id}`,
        label: shortcut.label,
        hint: shortcutHint(shortcut.keys),
        icon: <LuZap className={ICON} />,
        run: () => {
          shortcut.run();
        },
      });
      byGroup.set(shortcut.group, rows);
    }
    return Array.from(byGroup, ([heading, commands]) => ({
      heading,
      commands,
    }));
  }, [registered]);

  const issueActions = useMemo<Command[]>(() => {
    const actions: Command[] = registered
      .filter((shortcut) => shortcut.scope === 'issue')
      .map((shortcut) => ({
        id: `issue-action-${shortcut.id}`,
        label: shortcut.label,
        hint: shortcutHint(shortcut.keys),
        icon: <LuZap className={ICON} />,
        run: () => {
          shortcut.run();
        },
      }));
    const copiesUrl = registered.some(
      (shortcut) =>
        shortcut.scope === 'issue' && shortcut.keys === COPY_ISSUE_URL_KEYS
    );
    if (issueKey !== null && !copiesUrl) {
      actions.push({
        id: 'issue-copy-link',
        label: 'Copy issue link',
        keywords: 'url share',
        hint: issueKey,
        icon: <LuLink className={ICON} />,
        run: () => {
          void globalThis.navigator.clipboard
            .writeText(
              `${globalThis.location.origin}${issuePath(slug, issueKey)}`
            )
            .catch(() => undefined);
        },
      });
    }
    return actions;
  }, [registered, issueKey, slug]);

  const actions = useMemo<Command[]>(() => {
    const built: Command[] = [];
    if (canUndo) {
      built.push({
        id: 'action-undo',
        label: UNDO_LABEL,
        keywords: 'revert undo restore',
        hint: shortcutHint(UNDO_KEYS),
        icon: <LuUndo2 className={ICON} />,
        run: undo,
      });
    }
    if (createIssue.canCreate) {
      built.push({
        id: 'action-create-issue',
        label: 'Create issue',
        keywords: 'new',
        hint: 'C',
        icon: <LuSquarePen className={ICON} />,
        run: () => {
          createIssue.open();
        },
      });
      built.push({
        id: 'action-create-issue-fullscreen',
        label: 'Create issue in fullscreen',
        keywords: 'new expanded maximize',
        hint: shortcutHint(CREATE_FULLSCREEN_KEYS),
        icon: <LuMaximize2 className={ICON} />,
        run: () => {
          createIssue.open({ expanded: true });
        },
      });
      built.push({
        id: 'action-open-issue-drafts',
        label: 'Open drafts',
        keywords: 'draft drafts unfinished saved new issue resume',
        icon: <LuFileText className={ICON} />,
        run: () => {
          createIssue.open({ showDrafts: true });
        },
      });
      built.push({
        id: 'action-create-issue-template',
        label: 'Create issue from template',
        keywords: 'new template prefill',
        hint: shortcutHint(CREATE_FROM_TEMPLATE_KEYS),
        icon: <LuFileText className={ICON} />,
        page: 'template',
      });
    }
    if (createPlanning.canCreateProject) {
      built.push({
        id: 'action-create-project',
        label: 'Create project',
        keywords: 'new add',
        icon: <LuTarget className={ICON} />,
        run: createPlanning.openProject,
      });
    }
    if (createPlanning.canCreateInitiative) {
      built.push({
        id: 'action-create-initiative',
        label: 'Create initiative',
        keywords: 'new add goal',
        icon: <LuGoal className={ICON} />,
        run: createPlanning.openInitiative,
      });
    }
    if (createTeam.canCreate) {
      built.push({
        id: 'action-create-team',
        label: 'Create team',
        keywords: 'new add',
        icon: <LuUsersRound className={ICON} />,
        run: createTeam.open,
      });
      if (teams.some(isTopLevel)) {
        built.push({
          id: 'action-create-sub-team',
          label: 'Create sub-team',
          keywords: 'new add nested child parent team',
          icon: <LuUsersRound className={ICON} />,
          page: 'sub-team',
        });
      }
    }
    if (teams.length > 1) {
      built.push({
        id: 'action-switch-team',
        label: 'Switch team',
        keywords: 'change open',
        hint: 'O then T',
        icon: <LuArrowLeftRight className={ICON} />,
        page: 'teams',
      });
    }
    if (workspaces !== undefined) {
      built.push({
        id: 'action-switch-workspace',
        label: 'Switch workspace',
        keywords: 'change open organization',
        hint: 'O then W',
        icon: <LuBuilding2 className={ICON} />,
        page: 'workspaces',
      });
    }
    if (onLogOut !== undefined) {
      built.push({
        id: 'action-log-out',
        label: 'Log out',
        keywords: 'sign out signout logout leave',
        hint: shortcutHint(LOG_OUT_KEYS),
        icon: <LuLogOut className={ICON} />,
        run: onLogOut,
      });
    }
    for (const option of THEMES) {
      if (option.theme === theme) continue;
      built.push({
        id: `action-theme-${option.theme}`,
        label: option.label,
        keywords: 'toggle theme appearance',
        icon: option.icon,
        run: () => {
          setTheme(option.theme);
        },
      });
    }
    built.push({
      id: 'action-customize-sidebar',
      label: 'Customize sidebar',
      keywords: 'hide show more menu badge navigation personalize',
      icon: <LuSlidersHorizontal className={ICON} />,
      run: customizeSidebar.open,
    });
    if (leaveWorkspace !== null) {
      built.push({
        id: 'action-leave-workspace',
        label: 'Leave workspace',
        keywords: 'exit quit remove myself membership',
        icon: <LuDoorOpen className={ICON} />,
        run: leaveWorkspace.open,
      });
    }
    if (onShowShortcuts !== undefined) {
      built.push({
        id: 'action-shortcuts',
        label: 'Keyboard shortcuts',
        keywords: 'help keys',
        hint: '?',
        icon: <LuKeyboard className={ICON} />,
        run: onShowShortcuts,
      });
    }
    built.push(
      {
        id: 'action-create-view',
        label: 'Create view',
        keywords: 'new saved filter',
        icon: <LuLayers className={ICON} />,
        to: newViewPath(slug),
      },
      {
        id: 'action-open-view',
        label: 'Open view',
        keywords: 'saved filter go',
        hint: 'O then V',
        icon: <LuLayoutList className={ICON} />,
        page: 'views',
      },
      {
        id: 'action-open-favorite',
        label: 'Open favorite',
        keywords: 'starred go',
        hint: 'O then F',
        icon: <LuStar className={ICON} />,
        page: 'favorites',
      },
      {
        id: 'action-open-project',
        label: 'Open project',
        keywords: 'go',
        hint: 'O then P',
        icon: <LuTarget className={ICON} />,
        page: 'projects',
      },
      {
        id: 'action-open-member',
        label: 'Open member',
        keywords: 'go people person user teammate profile',
        hint: 'O then U',
        icon: <LuUsers className={ICON} />,
        page: 'members',
      }
    );
    if (currentUserId !== undefined) {
      built.push({
        id: 'action-open-my-profile',
        label: 'Open my profile',
        keywords: 'go me member page assigned',
        hint: 'O then M',
        icon: <LuUserRound className={ICON} />,
        to: memberPath(slug, currentUserId),
      });
    }
    if (team !== undefined) {
      built.push({
        id: 'action-open-cycle',
        label: 'Open cycle',
        keywords: 'go sprint',
        hint: 'O then C',
        icon: <LuRefreshCcw className={ICON} />,
        page: 'cycles',
      });
    }
    return built;
  }, [
    createIssue,
    createTeam,
    createPlanning,
    customizeSidebar,
    leaveWorkspace,
    slug,
    team,
    teams,
    theme,
    setTheme,
    onShowShortcuts,
    canUndo,
    undo,
    workspaces,
    onLogOut,
    currentUserId,
  ]);

  const places = useMemo<Command[]>(() => {
    const built: Command[] = [
      {
        id: 'nav-my-issues',
        label: 'My issues',
        hint: 'G then M',
        icon: <LuUserRound className={ICON} />,
        to: myIssuesPath(slug),
      },
      {
        id: 'nav-my-activity',
        label: 'My activity',
        keywords: 'recent changes comments history touched',
        icon: <LuActivity className={ICON} />,
        to: `${myIssuesPath(slug)}?tab=activity`,
      },
      {
        id: 'nav-inbox',
        label: 'Inbox',
        hint: 'G then I',
        icon: <LuInbox className={ICON} />,
        to: inboxPath(slug),
      },
      {
        id: 'nav-reviews',
        label: 'Reviews',
        keywords: 'pull requests review requested github',
        icon: <LuGitPullRequest className={ICON} />,
        to: reviewsPath(slug),
      },
      {
        id: 'nav-pulse',
        label: 'Pulse',
        keywords: 'project updates initiative updates health milestones feed',
        icon: <LuActivity className={ICON} />,
        to: pulsePath(slug),
      },
      {
        id: 'nav-projects',
        label: 'Projects',
        hint: 'G then P',
        icon: <LuTarget className={ICON} />,
        to: projectsPath(slug),
      },
    ];
    if (workspace.role !== 'guest') {
      built.push({
        id: 'nav-initiatives',
        label: 'Initiatives',
        keywords: 'goals strategy portfolio',
        icon: <LuGoal className={ICON} />,
        to: initiativesPath(slug),
      });
      built.push({
        id: 'nav-customers',
        label: 'Customers',
        keywords: 'accounts companies requests feedback',
        icon: <LuBuilding2 className={ICON} />,
        to: customersPath(slug),
      });
    }
    if (team !== undefined) {
      built.push({
        id: 'nav-triage',
        label: `${team.name} triage`,
        keywords: 'triage inbox waiting incoming',
        hint: 'G then T',
        icon: <LuInbox className={ICON} />,
        to: teamTriagePath(slug, team.key_prefix),
      });
      built.push({
        id: 'nav-team-issues',
        label: `${team.name} issues`,
        keywords: 'team issues all',
        hint: 'G then E',
        icon: <LuList className={ICON} />,
        to: teamPath(slug, team.key_prefix),
      });
      built.push({
        id: 'nav-team-active',
        label: 'Go to active issues',
        keywords: `${team.name} ${team.key_prefix} active started unstarted in progress todo`,
        hint: 'G then A',
        icon: <LuList className={ICON} />,
        to: teamScopePath(slug, team.key_prefix, 'active'),
      });
      built.push({
        id: 'nav-team-backlog',
        label: 'Go to backlog',
        keywords: `${team.name} ${team.key_prefix} backlog`,
        hint: 'G then B',
        icon: <LuList className={ICON} />,
        to: teamScopePath(slug, team.key_prefix, 'backlog'),
      });
      built.push({
        id: 'nav-board',
        label: `${team.name} board`,
        keywords: 'board kanban columns go to board',
        hint: 'G then D',
        icon: <LuSquareKanban className={ICON} />,
        to: teamBoardPath(slug, team.key_prefix),
      });
      built.push({
        id: 'nav-cycles',
        label: `${team.name} cycles`,
        keywords: 'cycles',
        hint: 'G then C',
        icon: <LuRefreshCcw className={ICON} />,
        to: teamCyclesPath(slug, team.key_prefix),
      });
      built.push({
        id: 'nav-upcoming-cycle',
        label: 'Go to upcoming cycle',
        keywords: `${team.name} ${team.key_prefix} next cycle sprint`,
        hint: 'G then W',
        icon: <LuRefreshCcw className={ICON} />,
        run: () => {
          void openUpcomingCycle({
            workspaceId,
            slug,
            team,
            navigate: (to) => {
              void navigate(to);
            },
          });
        },
      });
      built.push({
        id: 'nav-releases',
        label: `${team.name} releases`,
        keywords: 'releases deploys deployments shipped',
        icon: <LuRocket className={ICON} />,
        to: teamReleasesPath(slug, team.key_prefix),
      });
      built.push({
        id: 'nav-team-views',
        label: `${team.name} views`,
        keywords: 'views saved filters go to views',
        ...(insideTeam ? { hint: shortcutHint('g shift+v') } : {}),
        icon: <LuLayers className={ICON} />,
        to: teamViewsPath(slug, team.key_prefix),
      });
      built.push({
        id: 'nav-archive',
        label: `${team.name} archived issues`,
        keywords: 'archive archived restore',
        hint: 'G then X',
        icon: <LuArchive className={ICON} />,
        to: teamArchivePath(slug, team.key_prefix),
      });
      built.push({
        id: 'nav-trash',
        label: `${team.name} recently deleted`,
        keywords: 'trash deleted restore recently deleted bin',
        icon: <LuTrash2 className={ICON} />,
        to: teamTrashPath(slug, team.key_prefix),
      });
    }
    built.push(
      {
        id: 'nav-roadmap',
        label: 'Roadmap',
        hint: 'G then R',
        icon: <LuMap className={ICON} />,
        to: roadmapPath(slug),
      },
      {
        id: 'nav-views',
        label: 'Views',
        ...(insideTeam ? {} : { hint: shortcutHint('g shift+v') }),
        icon: <LuLayers className={ICON} />,
        to: viewsPath(slug),
      },
      {
        id: 'nav-search',
        label: 'Search',
        hint: '/',
        icon: <LuSearch className={ICON} />,
        to: searchPath(slug),
      },
      {
        id: 'nav-settings',
        label: 'Settings',
        hint: 'G then S',
        icon: <LuSettings className={ICON} />,
        to: settingsLanding(workspace),
      },
      {
        id: 'nav-edit-profile',
        label: 'Edit profile',
        keywords: 'account profile name username handle avatar',
        icon: <LuUserRound className={ICON} />,
        to: profileSettingsPath(slug),
      },
      {
        id: 'nav-preferences',
        label: 'Preferences',
        keywords:
          'account preferences theme dark light font text size home view default page week start first day full names usernames display',
        icon: <LuSlidersHorizontal className={ICON} />,
        to: preferencesSettingsPath(slug),
      },
      {
        id: 'nav-account-security',
        label: 'Security & access',
        keywords:
          'account email sessions passkeys api keys two factor delete account',
        icon: <LuSettings className={ICON} />,
        to: accountSecuritySettingsPath(slug),
      },
      {
        id: 'nav-settings-teams',
        label: 'Manage teams',
        keywords: 'settings teams',
        icon: <LuUsers className={ICON} />,
        to: settingsTeamsPath(slug),
      },
      {
        id: 'nav-connect-assistant',
        label: 'Connect an AI assistant',
        keywords: 'mcp server claude cursor vs code copilot integration',
        icon: <LuBot className={ICON} />,
        to: mcpSetupPath(slug),
      },
      {
        id: 'nav-install-cli',
        label: 'Install the CLI',
        keywords: 'command line terminal shell pip pipx api key',
        icon: <LuTerminal className={ICON} />,
        to: cliSetupPath(slug),
      },
      ...teamTree(teams).map(({ team: row, nested, parentName }) => ({
        id: `nav-team-${row.id}`,
        label: `Go to ${row.name}`,
        keywords: parentName ?? '',
        hint: row.key_prefix,
        icon: <LuUsers className={ICON} />,
        to: teamPath(slug, row.key_prefix),
        indent: nested,
      }))
    );
    return built;
  }, [insideTeam, slug, team, teams, workspace, workspaceId, navigate]);

  const teamSettings = useMemo<Command[]>(
    () =>
      teamTree(teams).map(({ team: row, nested, parentName }) => ({
        id: `settings-team-${row.id}`,
        label: `${row.name} settings`,
        keywords: `team settings members labels statuses workflow ${parentName ?? ''}`,
        hint: row.key_prefix,
        icon: <LuSettings className={ICON} />,
        to: teamSettingsPath(slug, row.key_prefix),
        indent: nested,
      })),
    [teams, slug]
  );

  const settingsPages = useMemo<Command[]>(
    () =>
      settingsDestinations(workspace).map((row) => ({
        id: `settings-page-${row.id}`,
        label: row.label,
        keywords: row.keywords,
        icon: <LuSettings className={ICON} />,
        to: row.to,
      })),
    [workspace]
  );

  const teamSections = useMemo<Command[]>(
    () =>
      team === undefined
        ? []
        : teamSettingsDestinations(slug, team.key_prefix).map((row) => ({
            id: `team-section-${row.id}`,
            label: row.label,
            keywords: `${row.keywords} ${team.name}`,
            hint: team.key_prefix,
            icon: <LuSettings className={ICON} />,
            to: row.to,
          })),
    [team, slug]
  );

  const groups = useMemo<CommandGroup[]>(() => {
    if (page === 'teams') {
      const rows = rank(
        teamTree(teams).map(({ team: row, nested, parentName }) => ({
          id: `switch-${row.id}`,
          label: row.name,
          keywords: parentName ?? '',
          hint: row.key_prefix,
          indent: nested,
          icon: <LuUsers className={ICON} />,
          to: switchTeamPath(
            location.pathname,
            slug,
            routePrefix,
            row.key_prefix
          ),
        })),
        deferred
      );
      return rows.length === 0
        ? []
        : [{ heading: 'Switch team', commands: rows }];
    }

    if (page === 'workspaces') {
      const rows = rank(
        (workspaces ?? [])
          .filter((row) => row.id !== workspaceId)
          .map((row) => ({
            id: `workspace-${row.id}`,
            label: row.name,
            keywords: row.slug,
            icon: <LuBuilding2 className={ICON} />,
            to: homeViewPath(row.slug),
          })),
        deferred
      );
      const create = rank(
        [
          {
            id: 'workspace-create',
            label: 'Create workspace',
            keywords: 'new add join',
            icon: <LuPlus className={ICON} />,
            to: NEW_WORKSPACE_PATH,
          },
        ],
        deferred
      );
      return [
        ...(rows.length === 0
          ? []
          : [{ heading: 'Switch workspace', commands: rows }]),
        ...(create.length === 0
          ? []
          : [{ heading: 'Workspace', commands: create }]),
      ];
    }

    if (page === 'favorites') {
      const rows = rank(
        (favorites ?? []).flatMap((favorite) => {
          const href = favoriteHref(slug, favorite);
          return href === null
            ? []
            : [
                {
                  id: `favorite-${favorite.kind}-${favorite.target_id}`,
                  label: favorite.title,
                  keywords: favorite.kind,
                  ...(favorite.issue_key ? { hint: favorite.issue_key } : {}),
                  icon: <LuStar className={ICON} />,
                  to: href,
                },
              ];
        }),
        deferred
      );
      return rows.length === 0
        ? []
        : [{ heading: 'Favorites', commands: rows }];
    }

    if (page === 'projects') {
      const rows = rank(
        (projectList?.projects ?? []).map((project) => ({
          id: `project-${project.project_id}`,
          label: project.name,
          icon: (
            <ProjectIcon
              icon={project.icon}
              color={project.color}
              className="h-4 w-4"
            />
          ),
          to: projectPath(slug, project),
        })),
        deferred
      );
      return rows.length === 0 ? [] : [{ heading: 'Projects', commands: rows }];
    }

    if (page === 'cycles') {
      const rows = rank(
        (team === undefined ? [] : pickerCycles(cycleList?.cycles ?? [])).map(
          (cycle) => ({
            id: `cycle-${cycle.cycle_id}`,
            label: cycle.name,
            hint: CYCLE_HINT[cycle.status],
            icon: <LuRefreshCcw className={ICON} />,
            to: cyclePath(slug, team?.key_prefix ?? '', cycle.cycle_id),
          })
        ),
        deferred
      );
      return rows.length === 0
        ? []
        : [{ heading: team?.name ?? 'Cycles', commands: rows }];
    }

    if (page === 'members') {
      const rows = rank(
        [...members]
          .sort((left, right) =>
            memberName(left).localeCompare(memberName(right))
          )
          .map((member) => ({
            id: `open-member-${member.user_id}`,
            label: memberName(member),
            keywords: `${member.full_name ?? ''} ${member.display_name ?? ''}`,
            ...(member.user_id === currentUserId ? { hint: 'You' } : {}),
            icon: <LuUserRound className={ICON} />,
            to: memberPath(slug, member.user_id),
          })),
        deferred
      );
      return rows.length === 0 ? [] : [{ heading: 'Members', commands: rows }];
    }

    if (page === 'sub-team') {
      const rows = rank(
        teams.filter(isTopLevel).map((row) => ({
          id: `sub-team-of-${row.id}`,
          label: row.name,
          hint: row.key_prefix,
          icon: <LuUsers className={ICON} />,
          run: () => {
            createTeam.openSubTeam(row.id);
          },
        })),
        deferred
      );
      return rows.length === 0
        ? []
        : [{ heading: 'Parent team', commands: rows }];
    }

    if (page === 'template') {
      const rows = rank(
        (team === undefined ? [] : (templateList?.templates ?? [])).map(
          (template) => ({
            id: `template-${template.id}`,
            label: template.name,
            keywords: template.title ?? '',
            ...(template.id === templateList?.default_template_id
              ? { hint: 'Default' }
              : isFormTemplate(template)
                ? { hint: 'Form' }
                : {}),
            icon: <LuFileText className={ICON} />,
            run: () => {
              createIssue.open({
                ...(team === undefined ? {} : { teamId: team.id }),
                templateId: template.id,
              });
            },
          })
        ),
        deferred
      );
      if (
        rows.length === 0 &&
        team !== undefined &&
        templateList !== undefined &&
        templateList !== null &&
        templateList.templates.length === 0
      ) {
        return [
          {
            heading: 'This team has no templates yet.',
            commands: [
              {
                id: 'template-settings',
                label: 'Set up templates in team settings',
                icon: <LuSettings className={ICON} />,
                to: teamSettingsSectionPath(slug, team.key_prefix, 'templates'),
              },
            ],
          },
        ];
      }
      return rows.length === 0
        ? []
        : [{ heading: team?.name ?? 'Templates', commands: rows }];
    }

    if (page === 'views') {
      const rows = rank(
        (savedViews ?? []).map((view) => ({
          id: `view-${view.view_id}`,
          label: view.name,
          keywords: view.description ?? '',
          icon: (
            <ViewIcon
              icon={view.icon ?? null}
              color={view.color ?? null}
              layout={view.layout}
              className={ICON}
            />
          ),
          to: viewPath(slug, view.view_id),
        })),
        deferred
      );
      return rows.length === 0 ? [] : [{ heading: 'Views', commands: rows }];
    }

    const built: CommandGroup[] = [];

    if (isKey) {
      const key = deferred.toUpperCase();
      built.push({
        heading: 'Issue',
        commands: [
          {
            id: `key-${key}`,
            label: `Go to ${key}`,
            icon: <LuArrowRight className={ICON} />,
            to: issuePath(slug, key),
          },
        ],
      });
    }

    const current = rank(issueActions, deferred);
    const currentGroup: CommandGroup | null =
      current.length === 0
        ? null
        : {
            heading: issueKey === null ? 'Current issue' : issueKey,
            commands: current,
          };
    if (currentGroup !== null && issueKey !== null) built.push(currentGroup);

    const viewing = issueKey?.toUpperCase() ?? null;
    const recent = rank(
      recents
        .filter((row) => row.key.toUpperCase() !== viewing)
        .map((row) => ({
          id: `recent-${row.id}`,
          label: row.title,
          hint: row.key,
          icon: <RecentIssueIcon workspaceId={workspaceId} issue={row} />,
          to: issuePath(slug, row.key),
        })),
      deferred
    );
    if (recent.length > 0) {
      built.push({ heading: 'Recent issues', commands: recent });
    }
    const shownRecent = new Set(recent.map((command) => command.id));
    if (currentGroup !== null && issueKey === null) built.push(currentGroup);

    for (const group of pageActions) {
      const here = rank(group.commands, deferred);
      if (here.length > 0)
        built.push({ heading: group.heading, commands: here });
    }

    const offered = subject?.values;
    if (!isKey && deferred !== '' && offered !== undefined) {
      const lowered = deferred.toLowerCase();
      const values = rankRows(
        offered(),
        deferred,
        (value) => value.label,
        (value) => [value.keywords]
      )
        .map(({ row: value, match }, at) => ({
          value,
          match,
          at,
          lead: value.name.toLowerCase().startsWith(lowered) ? 0 : 1,
        }))
        .sort((left, right) => left.lead - right.lead || left.at - right.at)
        .slice(0, VALUE_LIMIT)
        .map(({ value, match }) => ({
          id: `value-${value.id}`,
          label: value.label,
          keywords: value.keywords,
          ranges: match.ranges,
          icon: (
            <span className="inline-flex h-4 w-4 items-center justify-center">
              {value.icon}
            </span>
          ),
          run: value.run,
        }));
      if (values.length > 0) {
        built.push({ heading: 'Change property', commands: values });
      }
    }

    const results = (data ?? []).filter(
      (result) => !shownRecent.has(`recent-${result.issue_id}`)
    );
    if (!isKey && enabled && results.length > 0) {
      built.push({
        heading: 'Issues',
        commands: results.map((result) => ({
          id: `issue-${result.issue_id}`,
          label: result.title,
          ranges: fuzzyMatch(result.title, [], deferred).ranges,
          hint: result.key,
          icon: <LuCircleDot className={ICON} />,
          to: issuePath(slug, result.key),
        })),
      });
    }

    if (!isKey && deferred !== '') {
      const found = rank(
        (documents ?? []).map((row) => ({
          id: `document-${row.document_id}`,
          label: row.title,
          hint: row.parent_name,
          icon: <DocumentIcon icon={row.icon ?? null} className={ICON} />,
          to: documentPath(slug, row.document_id),
        })),
        deferred
      ).slice(0, DOCUMENT_LIMIT);
      if (found.length > 0) {
        built.push({ heading: 'Documents', commands: found });
      }
    }

    if (!isKey && deferred !== '') {
      const people = rank(
        members.map((member) => ({
          id: `member-${member.user_id}`,
          label: `Go to member ${memberName(member)}`,
          keywords: `people person member ${member.full_name ?? ''}`,
          icon: <LuUserRound className={ICON} />,
          to: memberPath(slug, member.user_id),
        })),
        deferred
      ).slice(0, DOCUMENT_LIMIT);
      if (people.length > 0) {
        built.push({ heading: 'People', commands: people });
      }
    }

    const doable = rank(actions, deferred);
    if (deferred === '' && routePrefix !== null) {
      const here = teams.find((row) => row.key_prefix === routePrefix);
      if (here !== undefined) {
        doable.push({
          id: `settings-current-${here.id}`,
          label: `${here.name} settings`,
          hint: here.key_prefix,
          icon: <LuSettings className={ICON} />,
          to: teamSettingsPath(slug, here.key_prefix),
        });
      }
    }
    if (doable.length > 0) built.push({ heading: 'Actions', commands: doable });

    const going = rank(places, deferred);
    if (going.length > 0) built.push({ heading: 'Go to', commands: going });

    if (deferred !== '') {
      const settings = rank(teamSettings, deferred);
      if (settings.length > 0) {
        built.push({ heading: 'Team settings', commands: settings });
      }
      const pages = rank(settingsPages, deferred);
      if (pages.length > 0) {
        built.push({ heading: 'Settings', commands: pages });
      }
      const sections = rank(teamSections, deferred);
      if (team !== undefined && sections.length > 0) {
        built.push({ heading: `${team.name} settings`, commands: sections });
      }
    }

    return built;
  }, [
    page,
    workspaces,
    savedViews,
    favorites,
    projectList,
    cycleList,
    templateList,
    team,
    createIssue,
    teams,
    createTeam,
    location.pathname,
    slug,
    routePrefix,
    deferred,
    isKey,
    recents,
    workspaceId,
    issueActions,
    pageActions,
    issueKey,
    subject,
    data,
    documents,
    members,
    currentUserId,
    enabled,
    actions,
    places,
    teamSettings,
    settingsPages,
    teamSections,
  ]);

  const flat = useMemo(
    () => groups.flatMap((group) => group.commands),
    [groups]
  );

  const index = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);
  const current = flat[index];

  const enterPage = useCallback((next: Page) => {
    setPage(next);
    setTerm('');
    setActive(0);
    input.current?.focus();
  }, []);

  const activate = useCallback(
    (command: Command) => {
      if (command.page !== undefined) {
        enterPage(command.page);
        return;
      }
      onClose();
      if (command.to !== undefined) {
        void navigate(command.to);
        return;
      }
      const run = command.run;
      if (run !== undefined) globalThis.setTimeout(run, 0);
    },
    [enterPage, navigate, onClose]
  );

  const move = useCallback(
    (delta: number) => {
      setActive((previous) => {
        if (flat.length === 0) return 0;
        const from = Math.min(previous, flat.length - 1);
        return (from + delta + flat.length) % flat.length;
      });
    },
    [flat.length]
  );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    input.current?.focus();
    return () => {
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(
      '[data-active="true"]'
    );
    if (typeof row?.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [index, flat.length]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Backspace' && term === '' && page !== 'root') {
      event.preventDefault();
      enterPage('root');
      return;
    }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (current !== undefined) activate(current);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      input.current?.focus();
    }
  };

  const empty =
    page === 'root' && deferred !== '' && !isKey && !indexable
      ? `Type at least ${String(MIN_TERM)} characters to search.`
      : isLoading && enabled
        ? 'Searching'
        : page === 'template' && (templateList?.templates.length ?? 0) === 0
          ? 'This team has no templates yet.'
          : page === 'favorites' && deferred === ''
            ? 'Nothing is starred yet.'
            : 'Nothing matched that.';

  const placeholder =
    page === 'root' ? 'Type a command or search' : PAGE_COPY[page].placeholder;

  let cursor = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-[2px] sm:px-4 sm:pt-[12vh] sm:pb-6 dark:bg-black/60"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex h-dvh w-full max-w-xl flex-col overflow-hidden bg-overlay pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-overlay sm:h-auto sm:max-h-[60vh] sm:rounded-lg sm:border sm:border-line sm:pt-0 sm:pb-0"
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        {page !== 'root' && (
          <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5">
            <button
              type="button"
              onClick={() => {
                enterPage('root');
              }}
              className="inline-flex h-5 items-center gap-1 rounded-xs bg-raised px-1.5 text-2xs text-text-muted pointer-coarse:h-8 pointer-coarse:px-2.5 pointer-coarse:text-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
            >
              <LuChevronLeft aria-hidden="true" className="h-3 w-3" />
              {PAGE_COPY[page].back}
            </button>
          </div>
        )}
        {page === 'root' && subject !== null && (
          <div className="flex shrink-0 items-center px-3 pt-2.5">
            <span
              data-testid="palette-subject"
              className="inline-flex h-5 max-w-full min-w-0 items-center gap-1.5 rounded-xs bg-raised px-1.5 text-2xs text-text-muted"
            >
              {subject.key !== null && (
                <span className="shrink-0 font-mono text-text">
                  {subject.key}
                </span>
              )}
              <span className="truncate">{subject.title}</span>
            </span>
          </div>
        )}
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3.5 pointer-coarse:h-12">
          <LuSearch aria-hidden="true" className="h-4 w-4 text-text-faint" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label={placeholder}
            aria-autocomplete="list"
            {...(current === undefined
              ? {}
              : { 'aria-activedescendant': `${listId}-${current.id}` })}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              setActive(0);
            }}
          />
          <kbd className="hidden shrink-0 rounded-xs border border-line px-1.5 py-0.5 font-sans text-2xs text-text-faint sm:block">
            Esc
          </kbd>
          <button
            type="button"
            aria-label="Close command palette"
            onClick={onClose}
            className="-mr-2 inline-flex h-10 shrink-0 items-center rounded-sm px-2 text-sm font-medium text-accent hover:opacity-90 active:opacity-75 sm:hidden"
          >
            Cancel
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {flat.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-sm text-text-muted">
              {empty}
            </p>
          ) : (
            <ul ref={list} id={listId} role="listbox" aria-label="Commands">
              {groups.map((group) => (
                <li key={group.heading} role="presentation">
                  <div
                    role="presentation"
                    className="px-3.5 pt-2 pb-1 text-xs text-text-faint"
                  >
                    {group.heading}
                  </div>
                  <ul role="group" aria-label={group.heading}>
                    {group.commands.map((command) => {
                      cursor += 1;
                      const at = cursor;
                      const selected = at === index;
                      return (
                        <li
                          key={command.id}
                          id={`${listId}-${command.id}`}
                          role="option"
                          aria-selected={selected}
                          data-active={selected}
                          className={cn(
                            'mx-1.5 flex h-9 cursor-pointer pointer-coarse:h-11 items-center gap-2.5 rounded-sm text-sm hover:bg-raised hover:text-text active:bg-line',
                            selected
                              ? 'bg-raised text-text'
                              : 'text-text-muted',
                            command.indent === true ? 'pr-2 pl-7' : 'px-2'
                          )}
                          onMouseMove={() => {
                            setActive(at);
                          }}
                          onClick={() => {
                            activate(command);
                          }}
                        >
                          <span className="text-text-faint">
                            {command.icon}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            <HighlightedLabel
                              label={command.label}
                              ranges={command.ranges}
                            />
                          </span>
                          {command.hint !== undefined && (
                            <span className="shrink-0 font-mono text-xs text-text-faint">
                              {command.hint}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

/** The palette, rendered only while it is open. */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  ...props
}) => (open ? <PaletteBody {...props} /> : null);

export default CommandPalette;
