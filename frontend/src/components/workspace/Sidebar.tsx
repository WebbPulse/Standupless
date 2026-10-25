/**
 * The workspace sidebar: the workspace menu with the create and search
 * buttons beside it, the caller's own inbox and issues, the places that span
 * the workspace, their favorites, then a section per team, each expanding to
 * that team's issues, cycles, releases and projects. Rendered as the fixed rail on wide
 * screens and inside a drawer on phones.
 *
 * A team section expands rather than the sidebar changing shape with the
 * route, so the caller keeps sight of the other teams while working inside
 * one. Which sections are open is remembered per workspace, because the set a
 * person cares about is stable and re-opening them on every visit is work the
 * interface can do for them.
 *
 * The teams sit in the caller's own order, which a drag or Alt with an arrow
 * key changes and the server keeps per person and workspace, so the order
 * follows them to every device. The new order shows at once and settles when
 * the saved list is read back. A sub-team sits indented just under its parent
 * team, in the caller's order among its siblings.
 *
 * Favorites are whatever the caller starred: issues, projects, cycles, views,
 * teams, documents and initiatives, in their own order. The star is kept by the
 * server per person, so the section agrees on every device they sign in on.
 *
 * Each person picks which top-level items show, which sit in the More menu at
 * the foot of the Workspace section and which are hidden, from the Customize
 * sidebar dialog or a right click on an item, and whether the unread badges
 * show a count or a dot. The choice is kept on the account, so it follows them
 * to every device; a hidden item is still reached by its shortcut and the
 * command palette.
 *
 * The workspace menu lists every workspace the caller belongs to, the current
 * one checked, so switching is one pick, and ends on Log out.
 *
 * The footer's sign-out button carries the same `sign-out` test id as the
 * account shell's, because signing in lands a person with one workspace inside
 * it, and the post-deploy suite signs out through that one id wherever it lands.
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LuActivity,
  LuBuilding2,
  LuCheck,
  LuChevronRight,
  LuChevronsUpDown,
  LuCircleDot,
  LuEllipsis,
  LuGitPullRequest,
  LuGoal,
  LuHouse,
  LuInbox,
  LuLayers,
  LuList,
  LuLock,
  LuLogOut,
  LuMap,
  LuPanelLeftClose,
  LuPlus,
  LuRefreshCcw,
  LuRocket,
  LuSearch,
  LuSquarePen,
  LuTarget,
  LuUserRound,
  LuUsersRound,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { setTeamOrder } from '../../api/teams';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useCreateTeam } from '../../hooks/useCreateTeam';
import { useCustomizeSidebar } from '../../hooks/useCustomizeSidebar';
import { useSidebarPreference } from '../../hooks/useSidebarPreference';
import { useCyclesOn } from '../../hooks/useCyclesOn';
import { cn } from '../../lib/cn';
import { useTriageSummary } from '../../hooks/useSidebarData';
import {
  ALL_WORKSPACES_PATH,
  NEW_WORKSPACE_PATH,
  PRIVACY_PATH,
  TERMS_PATH,
  inboxPath,
  myIssuesPath,
  projectsPath,
  customersPath,
  initiativesPath,
  pulsePath,
  reviewsPath,
  roadmapPath,
  routeTeamPrefix,
  searchPath,
  settingsTeamsPath,
  teamArchivePath,
  teamBoardPath,
  teamCurrentCyclePath,
  teamCyclesPath,
  teamPath,
  teamProjectsPath,
  teamReleasesPath,
  teamSettingsPath,
  teamTriagePath,
  teamViewsPath,
  viewsPath,
  workspacePath,
  accountSecuritySettingsPath,
  preferencesSettingsPath,
  profileSettingsPath,
} from '../../lib/paths';
import {
  applyTeamOrder,
  areSiblings,
  isNested,
  moveTeam,
  nestTeams,
  siblingIndex,
} from '../../lib/teamOrder';
import { homeViewPath } from '../../lib/preferences';
import { settingsLanding } from '../../lib/workspaceNav';
import {
  PERSONAL_ITEMS,
  SIDEBAR_ITEMS,
  WORKSPACE_ITEMS,
  itemAvailable,
  sidebarItemLabel,
} from '../../lib/sidebarItems';
import { Logo } from '../../brand';
import type {
  SidebarItem,
  SidebarVisibility,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import Menu, {
  ContextMenu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from '../ui/menu';
import { Skeleton } from '../ui/skeleton';
import ThemeToggle from '../ui/theme-toggle';
import { TruncatedText } from '../ui/truncated-text';
import InboxBadge from '../views/InboxBadge';
import PulseBadge from '../views/PulseBadge';
import ReviewsBadge from '../views/ReviewsBadge';
import FavoritesSection from './FavoritesSection';
import { useTeamsFor } from '../../hooks/useTeams';

/** Props for Sidebar: the workspace and what to do when a link is followed. */
export interface SidebarProps {
  workspace: WorkspaceRead;
  /** Called after any link is followed, so a drawer can close. */
  onNavigate?: () => void;
  /** Collapses the desktop sidebar. Without it no collapse button shows. */
  onCollapse?: () => void;
}

const ICON = 'h-4 w-4 shrink-0';
const SUB_ICON = 'h-3.5 w-3.5 shrink-0';
const FOCUS =
  'focus-visible:bg-raised/70 focus-visible:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none active:bg-line';

/**
 * Row hover, held back until the pointer moves over the nav. Every page mounts
 * its own sidebar, so without this the row that happens to sit under a pointer
 * resting after a click (the workspace menu drops over Inbox) lights up on the
 * new page and reads as the current one.
 */
const HOVER =
  'group-data-[pointer]/nav:hover:bg-raised/70 group-data-[pointer]/nav:hover:text-text';

/** The look of a top-level row, lit when it is the current page. */
const itemClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    'flex h-7 items-center gap-2 rounded-sm px-2 text-sm transition-colors duration-100 pointer-coarse:h-11',
    FOCUS,
    isActive ? 'bg-raised font-medium text-text' : cn('text-text-muted', HOVER)
  );

/** The look of a row inside a team section, indented under the team. */
const subItemClass = (
  { isActive }: { isActive: boolean },
  indent = 'pl-7'
): string =>
  cn(
    'flex h-7 items-center gap-2 rounded-sm pr-2 text-sm transition-colors duration-100 pointer-coarse:h-11',
    indent,
    FOCUS,
    isActive ? 'bg-raised font-medium text-text' : cn('text-text-muted', HOVER)
  );

/** Where the expanded team sections are remembered, one entry per workspace. */
const storageKey = (workspaceId: string): string =>
  `standupless.sidebar.teams.${workspaceId}`;

/**
 * The remembered set of expanded teams. Storage can be unavailable or hold
 * something another version wrote, so anything unreadable falls back to none
 * expanded rather than failing the render.
 */
const readExpanded = (workspaceId: string): string[] => {
  if (workspaceId === '') return [];
  try {
    const raw = globalThis.localStorage.getItem(storageKey(workspaceId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is string => typeof row === 'string');
  } catch {
    return [];
  }
};

/**
 * Remembers the expanded set, ignoring a storage that refuses the write,
 * because a private window or a full quota is not a reason to fail the sidebar.
 */
const writeExpanded = (workspaceId: string, keys: string[]): void => {
  if (workspaceId === '') return;
  try {
    globalThis.localStorage.setItem(
      storageKey(workspaceId),
      JSON.stringify(keys)
    );
  } catch {
    return;
  }
};

/** Copies an in-application path as a full link, ignoring a refused clipboard. */
const copyLink = (path: string): void => {
  void globalThis.navigator.clipboard
    .writeText(`${globalThis.location.origin}${path}`)
    .catch(() => undefined);
};

/** A small heading over a run of rows, with an optional action on its right. */
const SectionHeading: React.FC<{
  id: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}> = ({ id, children, action }) => (
  <div
    data-sidebar-heading=""
    className="group/heading flex h-6 items-center pr-1 pl-2 pointer-coarse:h-11"
  >
    <h2 id={id} className="flex-1 text-2xs font-medium text-text-faint">
      {children}
    </h2>
    {action}
  </div>
);

/** One top-level sidebar row: where it goes, how it reads, and its badge. */
interface RowSpec {
  item: SidebarItem;
  label: string;
  icon: IconType;
  to: string;
  badge?: React.ReactNode;
  /** Whether the row is lit, for a row whose page the route alone cannot tell. */
  active?: boolean;
  /** Lights the row on every page under its path, not only the path itself. */
  prefix?: boolean;
}

/** Which edge of a team section the drop line is drawn on, if either. */
type DropEdge = 'before' | 'after' | null;

/** The id of a team's toggle, so a keyboard move can keep focus on it. */
const toggleId = (teamId: string): string => `team-toggle-${teamId}`;

/** Props for TeamSection: one team and whether its surfaces are showing. */
interface TeamSectionProps {
  slug: string;
  /** The workspace the team belongs to, for the reads the section makes. */
  workspaceId: string;
  team: TeamRead;
  /** Whether the team shows nested under its parent team. */
  nested: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onNavigate?: (() => void) | undefined;
  pathname: string;
  /** True while the projects list is filtered to this team. */
  isProjectsActive: boolean;
  /** How many issues wait in the team's triage inbox, or null when triage is off. */
  triageCount: number | null;
  /** Where a move up lands among the team's siblings, or null when it is first. */
  upTo: number | null;
  /** Where a move down lands among the team's siblings, or null when it is last. */
  downTo: number | null;
  /** Whether the caller may move teams, false while there is only one. */
  canReorder: boolean;
  dragging: boolean;
  dropEdge: DropEdge;
  /** Moves this team to another place in the list. */
  onMove: (to: number) => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  /** Opens the create team dialog with this team as the parent, or undefined when it cannot take one. */
  onCreateSubTeam?: (() => void) | undefined;
}

/**
 * One team in the sidebar, expanding to the surfaces that belong to it, with
 * a menu of the team's own actions that shows on hover or focus. The section
 * drags by its header to a new place, Alt with an arrow key moves it from the
 * keyboard, and the menu offers the same moves for a touch screen.
 */
const TeamSection: React.FC<TeamSectionProps> = ({
  slug,
  workspaceId,
  team,
  nested,
  isOpen,
  onToggle,
  onNavigate,
  pathname,
  isProjectsActive,
  triageCount,
  upTo,
  downTo,
  canReorder,
  dragging,
  dropEdge,
  onMove,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
  onCreateSubTeam,
}) => {
  const panelId = `team-nav-${team.id}`;
  const cyclesOn = useCyclesOn(workspaceId, team.id, isOpen);
  const home = teamPath(slug, team.key_prefix);
  const issuesActive =
    pathname === home || pathname === teamBoardPath(slug, team.key_prefix);

  return (
    <div
      className={cn(
        'group/team relative',
        nested && 'ml-3',
        dragging && 'opacity-50'
      )}
      data-testid={`team-section-${team.id}`}
      draggable={canReorder}
      onDragStart={(event) => {
        if (
          event.target instanceof Node &&
          document.getElementById(panelId)?.contains(event.target) === true
        ) {
          return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', team.id);
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        if (canReorder) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      {dropEdge !== null && (
        <span
          aria-hidden="true"
          data-testid="team-drop-indicator"
          className={cn(
            'pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded-full bg-accent',
            dropEdge === 'before' ? '-top-px' : '-bottom-px'
          )}
        />
      )}
      <button
        type="button"
        id={toggleId(team.id)}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (!canReorder || !event.altKey) return;
          if (event.key === 'ArrowUp' && upTo !== null) {
            event.preventDefault();
            onMove(upTo);
          }
          if (event.key === 'ArrowDown' && downTo !== null) {
            event.preventDefault();
            onMove(downTo);
          }
        }}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-keyshortcuts={canReorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        className={cn(
          'flex h-7 w-full items-center gap-1.5 rounded-sm pr-8 pl-2 text-sm transition-colors duration-100 pointer-coarse:h-11 pointer-coarse:pr-12',
          'text-text-muted',
          HOVER,
          FOCUS
        )}
      >
        <Avatar
          name={team.name}
          src={team.icon_url}
          size="sm"
          shape="square"
          className="h-4 w-4 text-2xs"
        />
        <TruncatedText className="min-w-0 text-left font-medium">
          {team.name}
        </TruncatedText>
        {team.private === true && (
          <LuLock
            aria-label="Private team"
            className="h-3 w-3 shrink-0 text-text-faint"
          />
        )}
        <LuChevronRight
          aria-hidden="true"
          className={cn(
            'h-3 w-3 shrink-0 text-text-faint transition-transform duration-100',
            isOpen && 'rotate-90'
          )}
        />
      </button>
      <Menu
        label={`${team.name} actions`}
        align="end"
        className="absolute top-0.5 right-1 pointer-coarse:top-0 pointer-coarse:right-0"
        trigger={(props) => (
          <IconButton
            label="Team options"
            size="sm"
            className="h-6 w-6 opacity-0 group-focus-within/team:opacity-100 group-hover/team:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
            {...props}
          >
            <LuEllipsis className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        <MenuItem to={teamSettingsPath(slug, team.key_prefix)}>
          Team settings
        </MenuItem>
        <MenuItem to={teamArchivePath(slug, team.key_prefix)}>
          Show archived issues
        </MenuItem>
        <MenuItem
          onSelect={() => {
            copyLink(home);
          }}
        >
          Copy link
        </MenuItem>
        {onCreateSubTeam !== undefined && (
          <MenuItem onSelect={onCreateSubTeam}>Create sub-team</MenuItem>
        )}
        {canReorder && <MenuSeparator />}
        {canReorder && upTo !== null && (
          <MenuItem
            onSelect={() => {
              onMove(upTo);
            }}
          >
            Move up
          </MenuItem>
        )}
        {canReorder && downTo !== null && (
          <MenuItem
            onSelect={() => {
              onMove(downTo);
            }}
          >
            Move down
          </MenuItem>
        )}
      </Menu>

      <div id={panelId} hidden={!isOpen} className="mt-px space-y-px">
        {triageCount !== null && (
          <NavLink
            to={teamTriagePath(slug, team.key_prefix)}
            end
            className={subItemClass}
            onClick={onNavigate}
          >
            <LuInbox className={SUB_ICON} aria-hidden="true" />
            <span className="flex-1">Triage</span>
            {triageCount > 0 && (
              <span
                aria-label={`${String(triageCount)} waiting`}
                className="text-2xs text-text-faint tabular-nums"
              >
                {triageCount >= 100 ? '99+' : String(triageCount)}
              </span>
            )}
          </NavLink>
        )}
        <Link
          to={home}
          className={subItemClass({ isActive: issuesActive })}
          aria-current={issuesActive ? 'page' : undefined}
          onClick={onNavigate}
        >
          <LuList className={SUB_ICON} aria-hidden="true" />
          Issues
        </Link>
        <NavLink
          to={teamCyclesPath(slug, team.key_prefix)}
          end
          className={subItemClass}
          onClick={onNavigate}
        >
          <LuRefreshCcw className={SUB_ICON} aria-hidden="true" />
          Cycles
        </NavLink>
        {cyclesOn && (
          <NavLink
            to={teamCurrentCyclePath(slug, team.key_prefix)}
            className={({ isActive }) => subItemClass({ isActive }, 'pl-12')}
            onClick={onNavigate}
          >
            <LuCircleDot className={SUB_ICON} aria-hidden="true" />
            Current cycle
          </NavLink>
        )}
        <NavLink
          to={teamReleasesPath(slug, team.key_prefix)}
          className={subItemClass}
          onClick={onNavigate}
        >
          <LuRocket className={SUB_ICON} aria-hidden="true" />
          Releases
        </NavLink>
        <Link
          to={teamProjectsPath(slug, team.key_prefix)}
          className={subItemClass({ isActive: isProjectsActive })}
          aria-current={isProjectsActive ? 'page' : undefined}
          onClick={onNavigate}
        >
          <LuTarget className={SUB_ICON} aria-hidden="true" />
          Projects
        </Link>
        <NavLink
          to={teamViewsPath(slug, team.key_prefix)}
          end
          className={subItemClass}
          onClick={onNavigate}
        >
          <LuLayers className={SUB_ICON} aria-hidden="true" />
          Views
        </NavLink>
      </div>
    </div>
  );
};

/**
 * The workspace navigation column. A team section is open when it was toggled
 * open, or when the current route is inside it, which is derived from the route
 * rather than stored. Arriving on a sub-team's page expands its parent and
 * saves that like a manual expand, once per arrival, so the active sub-team
 * shows in its nested place and collapsing the parent afterwards still hides it.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  workspace,
  onNavigate,
  onCollapse,
}) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const createIssue = useCreateIssue();
  const createTeam = useCreateTeam();
  const memberships = useContext(WorkspaceContext)?.workspaces;
  const switchable =
    memberships === undefined || memberships.length === 0
      ? [workspace]
      : memberships;
  const slug = workspace.slug;
  const onProjectsPage = /^\/w\/[^/]+\/projects\/?$/.test(location.pathname);
  const projectsTeam = onProjectsPage
    ? new URLSearchParams(location.search).get('team')
    : null;
  const allProjectsActive = onProjectsPage && projectsTeam === null;
  const prefix = routeTeamPrefix(location.pathname, location.search);

  const [expanded, setExpanded] = useState<string[]>(() =>
    readExpanded(workspace.id)
  );

  const { data: teams, refetch: refetchTeams } = useTeamsFor(workspace.id);
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const saveToken = useRef(0);
  const [pointerMoved, setPointerMoved] = useState(false);

  const preference = useSidebarPreference();
  const customize = useCustomizeSidebar();
  const [itemMenu, setItemMenu] = useState<{
    item: SidebarItem;
    x: number;
    y: number;
  } | null>(null);
  const openItemMenu = (item: SidebarItem, x: number, y: number): void => {
    setItemMenu({ item, x, y });
  };
  const closeItemMenu = useCallback(() => {
    setItemMenu(null);
  }, []);
  const placeOf = (item: SidebarItem): SidebarVisibility =>
    itemAvailable(item, workspace.role) ? preference.items[item] : 'hide';
  const badgeStyle = preference.badgeStyle;

  const rowSpecs: Record<SidebarItem, RowSpec> = {
    home: {
      item: 'home',
      label: 'Home',
      icon: LuHouse,
      to: workspacePath(slug),
    },
    inbox: {
      item: 'inbox',
      label: 'Inbox',
      icon: LuInbox,
      to: inboxPath(slug),
      badge: <InboxBadge workspaceId={workspace.id} badgeStyle={badgeStyle} />,
    },
    my_issues: {
      item: 'my_issues',
      label: 'My issues',
      icon: LuUserRound,
      to: myIssuesPath(slug),
    },
    reviews: {
      item: 'reviews',
      label: 'Reviews',
      icon: LuGitPullRequest,
      to: reviewsPath(slug),
      badge: (
        <ReviewsBadge workspaceId={workspace.id} badgeStyle={badgeStyle} />
      ),
    },
    pulse: {
      item: 'pulse',
      label: 'Pulse',
      icon: LuActivity,
      to: pulsePath(slug),
      badge: <PulseBadge workspaceId={workspace.id} badgeStyle={badgeStyle} />,
    },
    projects: {
      item: 'projects',
      label: 'Projects',
      icon: LuTarget,
      to: projectsPath(slug),
      active: allProjectsActive,
    },
    initiatives: {
      item: 'initiatives',
      label: 'Initiatives',
      icon: LuGoal,
      to: initiativesPath(slug),
      prefix: true,
    },
    customers: {
      item: 'customers',
      label: 'Customers',
      icon: LuBuilding2,
      to: customersPath(slug),
      prefix: true,
    },
    views: {
      item: 'views',
      label: 'Views',
      icon: LuLayers,
      to: viewsPath(slug),
    },
    roadmap: {
      item: 'roadmap',
      label: 'Roadmap',
      icon: LuMap,
      to: roadmapPath(slug),
    },
    teams: {
      item: 'teams',
      label: 'Your teams',
      icon: LuUsersRound,
      to: settingsTeamsPath(slug),
    },
  };
  const shownIn = (items: SidebarItem[]): RowSpec[] =>
    items
      .filter((item) => placeOf(item) === 'show')
      .map((item) => rowSpecs[item]);
  const personalRows = shownIn(PERSONAL_ITEMS);
  const workspaceRows = shownIn(WORKSPACE_ITEMS);
  const moreRows = SIDEBAR_ITEMS.filter(
    ({ item }) => placeOf(item) === 'more'
  ).map(({ item }) => rowSpecs[item]);

  const renderRow = (row: RowSpec): React.ReactNode => {
    const Icon = row.icon;
    const content = (
      <>
        <Icon className={ICON} aria-hidden="true" />
        <span className="flex-1">{row.label}</span>
        {row.badge}
      </>
    );
    const onContextMenu = (event: React.MouseEvent): void => {
      event.preventDefault();
      openItemMenu(row.item, event.clientX, event.clientY);
    };
    if (row.active !== undefined) {
      return (
        <Link
          key={row.item}
          to={row.to}
          className={itemClass({ isActive: row.active })}
          aria-current={row.active ? 'page' : undefined}
          onClick={onNavigate}
          onContextMenu={onContextMenu}
        >
          {content}
        </Link>
      );
    }
    return (
      <NavLink
        key={row.item}
        to={row.to}
        end={row.prefix !== true}
        className={itemClass}
        onClick={onNavigate}
        onContextMenu={onContextMenu}
      >
        {content}
      </NavLink>
    );
  };

  const triage = useTriageSummary(workspace.id);
  const triageCounts = useMemo(
    () => new Map((triage?.teams ?? []).map((row) => [row.team_id, row.count])),
    [triage]
  );

  const toggle = useCallback(
    (keyPrefix: string): void => {
      setExpanded((held) => {
        const next = held.includes(keyPrefix)
          ? held.filter((row) => row !== keyPrefix)
          : [...held, keyPrefix];
        writeExpanded(workspace.id, next);
        return next;
      });
    },
    [workspace.id]
  );

  const rows = useMemo(
    () =>
      nestTeams(
        applyTeamOrder(
          (teams ?? []).filter(
            (team) => team.private !== true || team.is_member === true
          ),
          pendingOrder
        )
      ),
    [teams, pendingOrder]
  );

  const moveTo = useCallback(
    (from: number, to: number, focus: boolean): void => {
      const ids = moveTeam(
        rows.map((team) => team.id),
        from,
        to
      );
      const moving = rows[from];
      if (ids === null || moving === undefined) return;
      saveToken.current += 1;
      const token = saveToken.current;
      setPendingOrder(ids);
      setAnnouncement(
        `Moved ${moving.name} to position ${String(to + 1)} of ${String(ids.length)}.`
      );
      if (focus) {
        globalThis.requestAnimationFrame(() => {
          document.getElementById(toggleId(moving.id))?.focus();
        });
      }
      void setTeamOrder(workspace.id, ids)
        .then(() => refetchTeams())
        .catch(() => {
          setAnnouncement('The team order could not be saved.');
        })
        .finally(() => {
          if (saveToken.current === token) setPendingOrder(null);
        });
    },
    [rows, workspace.id, refetchTeams]
  );

  const endDrag = (): void => {
    setDragFrom(null);
    setDragOver(null);
  };

  const dropEdgeOf = (index: number): DropEdge => {
    if (dragFrom === null || dragOver !== index || dragOver === dragFrom) {
      return null;
    }
    if (!areSiblings(rows, dragFrom, index)) return null;
    return index < dragFrom ? 'before' : 'after';
  };

  const isOpen = (team: TeamRead): boolean =>
    expanded.includes(team.key_prefix) || team.key_prefix === prefix;

  const isShown = (team: TeamRead): boolean => {
    if (!isNested(team, rows)) return true;
    const parent = rows.find((row) => row.id === team.parent_team_id);
    return parent === undefined || isOpen(parent);
  };

  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (revealedFor.current === prefix) return;
    if (prefix === null) {
      revealedFor.current = null;
      return;
    }
    const active = rows.find((row) => row.key_prefix === prefix);
    if (active === undefined) return;
    revealedFor.current = prefix;
    const parent = rows.find((row) => row.id === active.parent_team_id);
    if (parent === undefined) return;
    setExpanded((held) => {
      if (held.includes(parent.key_prefix)) return held;
      const next = [...held, parent.key_prefix];
      writeExpanded(workspace.id, next);
      return next;
    });
  }, [prefix, rows, workspace.id]);

  return (
    <div className="flex h-full flex-col bg-app">
      <div className="flex h-topbar items-center gap-0.5 px-2">
        <Menu
          label="Workspace"
          className="min-w-0 flex-1"
          trigger={(props) => (
            <button
              type="button"
              className={cn(
                'flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm font-semibold hover:bg-raised pointer-coarse:h-11',
                FOCUS
              )}
              {...props}
            >
              {workspace.icon_url ? (
                <Avatar
                  name={workspace.name}
                  src={workspace.icon_url}
                  size="sm"
                  shape="square"
                  className="h-[18px] w-[18px]"
                />
              ) : (
                <Logo size={18} title={null} />
              )}
              <TruncatedText className="min-w-0 flex-1">
                {workspace.name}
              </TruncatedText>
              <LuChevronsUpDown
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
                aria-hidden="true"
              />
            </button>
          )}
        >
          <MenuItem to={settingsLanding(workspace)}>
            Workspace settings
          </MenuItem>
          {createTeam.canCreate && (
            <MenuItem onSelect={createTeam.open}>Create team</MenuItem>
          )}
          <MenuItem onSelect={customize.open}>Customize sidebar</MenuItem>
          <MenuItem to={profileSettingsPath(workspace.slug)}>
            Edit profile
          </MenuItem>
          <MenuItem to={preferencesSettingsPath(workspace.slug)}>
            Preferences
          </MenuItem>
          <MenuItem to={accountSecuritySettingsPath(workspace.slug)}>
            Security &amp; access
          </MenuItem>
          <MenuSeparator />
          <MenuItem to={PRIVACY_PATH}>Privacy Policy</MenuItem>
          <MenuItem to={TERMS_PATH}>Terms of Service</MenuItem>
          <MenuSeparator />
          <MenuLabel>Switch workspace</MenuLabel>
          {switchable.map((row) => (
            <MenuItem
              key={row.id}
              to={homeViewPath(row.slug)}
              textValue={row.name}
            >
              <TruncatedText className="min-w-0 flex-1">
                {row.name}
              </TruncatedText>
              {row.id === workspace.id && (
                <>
                  <span className="sr-only"> (current)</span>
                  <LuCheck
                    className="h-3.5 w-3.5 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                </>
              )}
            </MenuItem>
          ))}
          <MenuItem to={NEW_WORKSPACE_PATH}>Create workspace</MenuItem>
          <MenuItem to={ALL_WORKSPACES_PATH}>All workspaces</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => void logout()}>Log out</MenuItem>
        </Menu>
        <IconButton
          label="Search issues"
          size="sm"
          onClick={() => {
            onNavigate?.();
            void navigate(searchPath(slug));
          }}
        >
          <LuSearch className="h-3.5 w-3.5" />
        </IconButton>
        {createIssue.canCreate && (
          <IconButton
            label={
              createIssue.hasDraft === true
                ? 'Create issue, draft saved'
                : 'Create issue'
            }
            size="sm"
            variant="secondary"
            className="relative"
            onClick={() => {
              onNavigate?.();
              createIssue.open();
            }}
          >
            <LuSquarePen className="h-3.5 w-3.5" />
            {createIssue.hasDraft === true && (
              <span
                aria-hidden="true"
                data-testid="issue-draft-dot"
                className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent"
              />
            )}
          </IconButton>
        )}
        {onCollapse !== undefined && (
          <IconButton label="Collapse sidebar" size="sm" onClick={onCollapse}>
            <LuPanelLeftClose className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>

      <nav
        aria-label="Workspace"
        data-pointer={pointerMoved ? '' : undefined}
        onPointerMove={
          pointerMoved
            ? undefined
            : () => {
                setPointerMoved(true);
              }
        }
        data-testid="sidebar-nav"
        className="group/nav relative min-h-0 min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-2 py-1 scrollbar-thin"
      >
        {personalRows.length > 0 && (
          <div className="space-y-px">{personalRows.map(renderRow)}</div>
        )}

        <FavoritesSection
          workspaceId={workspace.id}
          slug={slug}
          teams={teams}
          rowClass={itemClass}
          onNavigate={onNavigate}
          heading={
            <SectionHeading id="sidebar-favorites">Favorites</SectionHeading>
          }
        />

        {(workspaceRows.length > 0 || moreRows.length > 0) && (
          <section aria-labelledby="sidebar-workspace">
            <SectionHeading id="sidebar-workspace">Workspace</SectionHeading>
            <div className="space-y-px">
              {workspaceRows.map(renderRow)}
              {moreRows.length > 0 && (
                <Menu
                  label="More"
                  className="w-full"
                  trigger={(props) => (
                    <button
                      type="button"
                      data-testid="sidebar-more"
                      className={cn(itemClass({ isActive: false }), 'w-full')}
                      {...props}
                    >
                      <LuEllipsis className={ICON} aria-hidden="true" />
                      More
                    </button>
                  )}
                >
                  {moreRows.map((row) => {
                    const Icon = row.icon;
                    return (
                      <MenuItem
                        key={row.item}
                        textValue={row.label}
                        onSelect={() => {
                          onNavigate?.();
                          void navigate(row.to);
                        }}
                      >
                        <Icon className={ICON} aria-hidden="true" />
                        <span className="flex-1">{row.label}</span>
                        {row.badge}
                      </MenuItem>
                    );
                  })}
                  <MenuSeparator />
                  <MenuItem onSelect={customize.open}>
                    Customize sidebar
                  </MenuItem>
                </Menu>
              )}
            </div>
          </section>
        )}

        {placeOf('teams') === 'show' && (
          <section
            aria-labelledby="sidebar-teams"
            onContextMenu={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('[data-sidebar-heading]') === null
              ) {
                return;
              }
              event.preventDefault();
              openItemMenu('teams', event.clientX, event.clientY);
            }}
          >
            <SectionHeading
              id="sidebar-teams"
              action={
                createTeam.canCreate ? (
                  <IconButton
                    label="Create team"
                    size="sm"
                    className="h-5 w-5"
                    onClick={createTeam.open}
                  >
                    <LuPlus className="h-3 w-3" />
                  </IconButton>
                ) : undefined
              }
            >
              Your teams
            </SectionHeading>
            <div className="space-y-px">
              {rows.map((team, index) =>
                isShown(team) ? (
                  <TeamSection
                    key={team.id}
                    slug={slug}
                    workspaceId={workspace.id}
                    team={team}
                    nested={isNested(team, rows)}
                    isOpen={isOpen(team)}
                    onToggle={() => {
                      toggle(team.key_prefix);
                    }}
                    onNavigate={onNavigate}
                    pathname={location.pathname}
                    isProjectsActive={projectsTeam === team.key_prefix}
                    triageCount={triageCounts.get(team.id) ?? null}
                    upTo={siblingIndex(rows, index, -1)}
                    downTo={siblingIndex(rows, index, 1)}
                    canReorder={rows.length > 1}
                    dragging={dragFrom === index}
                    dropEdge={dropEdgeOf(index)}
                    onMove={(to) => {
                      moveTo(index, to, true);
                    }}
                    onDragStart={() => {
                      setDragFrom(index);
                    }}
                    onDragEnter={() => {
                      if (dragFrom !== null) setDragOver(index);
                    }}
                    onDragEnd={endDrag}
                    onCreateSubTeam={
                      createTeam.canCreate &&
                      (team.parent_team_id === null ||
                        team.parent_team_id === undefined)
                        ? () => {
                            createTeam.openSubTeam(team.id);
                          }
                        : undefined
                    }
                    onDrop={() => {
                      if (
                        dragFrom !== null &&
                        areSiblings(rows, dragFrom, index)
                      ) {
                        moveTo(dragFrom, index, false);
                      }
                      endDrag();
                    }}
                  />
                ) : null
              )}
              <p role="status" aria-live="polite" className="sr-only">
                {announcement}
              </p>
              {teams === null && (
                <div
                  role="status"
                  aria-label="Loading teams"
                  className="space-y-2 px-2 py-1.5"
                >
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              )}
              {rows.length === 0 && teams !== null && !createTeam.canCreate && (
                <p className="px-2 py-1 text-xs text-text-faint">
                  No teams yet.
                </p>
              )}
              {createTeam.canCreate && (
                <button
                  type="button"
                  onClick={createTeam.open}
                  className={cn(
                    'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-sm text-text-faint transition-colors duration-100 pointer-coarse:h-11',
                    HOVER,
                    FOCUS
                  )}
                >
                  <LuPlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Add team
                </button>
              )}
            </div>
          </section>
        )}
      </nav>
      {itemMenu !== null && (
        <ContextMenu
          x={itemMenu.x}
          y={itemMenu.y}
          label={`${sidebarItemLabel(itemMenu.item)} sidebar options`}
          onClose={closeItemMenu}
        >
          <MenuItem onSelect={customize.open}>Customize sidebar</MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              preference.place(itemMenu.item, 'hide');
            }}
          >
            Hide
          </MenuItem>
          <MenuItem
            onSelect={() => {
              preference.place(itemMenu.item, 'more');
            }}
          >
            Move to More
          </MenuItem>
        </ContextMenu>
      )}

      <div className="flex h-topbar items-center gap-1 border-t border-line px-2">
        {user !== null && (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1 text-xs text-text-muted">
            <Avatar
              name={user.display_name ?? user.email}
              src={user.avatar_url}
              size="sm"
            />
            <TruncatedText>{user.display_name ?? user.email}</TruncatedText>
          </span>
        )}
        <ThemeToggle />
        <IconButton
          label="Sign out"
          size="sm"
          onClick={() => void logout()}
          data-testid="sign-out"
        >
          <LuLogOut className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
};

export default Sidebar;
