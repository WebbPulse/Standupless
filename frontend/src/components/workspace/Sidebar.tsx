/**
 * The workspace sidebar: the workspace menu with the create and search
 * buttons beside it, the caller's own inbox and issues, the places that span
 * the workspace, their saved views, then a section per team, each expanding to
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
 * the saved list is read back.
 *
 * There is no favorites section: the API has nowhere to keep a person's
 * favorites yet, and a section that only lived in one browser would disagree
 * with every other device the person signs in on.
 *
 * The footer's sign-out button carries the same `sign-out` test id as the
 * account shell's, because signing in lands a person with one workspace inside
 * it, and the post-deploy suite signs out through that one id wherever it lands.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  LuChevronRight,
  LuChevronsUpDown,
  LuEllipsis,
  LuGoal,
  LuHouse,
  LuInbox,
  LuLayers,
  LuList,
  LuLock,
  LuLogOut,
  LuMap,
  LuPlus,
  LuRefreshCcw,
  LuRocket,
  LuSearch,
  LuSquarePen,
  LuTarget,
  LuUserRound,
} from 'react-icons/lu';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { setTeamOrder } from '../../api/teams';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useCreateTeam } from '../../hooks/useCreateTeam';
import { cn } from '../../lib/cn';
import { useOwnViews, useTriageSummary } from '../../hooks/useSidebarData';
import {
  ALL_WORKSPACES_PATH,
  PRIVACY_PATH,
  TERMS_PATH,
  inboxPath,
  myIssuesPath,
  projectsPath,
  initiativesPath,
  roadmapPath,
  routeTeamPrefix,
  searchPath,
  teamArchivePath,
  teamBoardPath,
  teamCyclesPath,
  teamPath,
  teamProjectsPath,
  teamReleasesPath,
  teamSettingsPath,
  teamTriagePath,
  viewPath,
  viewsPath,
  workspacePath,
} from '../../lib/paths';
import { applyTeamOrder, moveTeam } from '../../lib/teamOrder';
import { settingsLanding } from '../../lib/workspaceNav';
import { Logo } from '../../brand';
import type { TeamRead, WorkspaceRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import { Skeleton } from '../ui/skeleton';
import ThemeToggle from '../ui/theme-toggle';
import InboxBadge from '../views/InboxBadge';
import { useTeamsFor } from '../../hooks/useTeams';

/** Props for Sidebar: the workspace and what to do when a link is followed. */
export interface SidebarProps {
  workspace: WorkspaceRead;
  /** Called after any link is followed, so a drawer can close. */
  onNavigate?: () => void;
}

/** How many of the caller's views the sidebar lists before pointing at the rest. */
const VIEW_LIMIT = 6;

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
const subItemClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    'flex h-7 items-center gap-2 rounded-sm pr-2 pl-7 text-sm transition-colors duration-100 pointer-coarse:h-11',
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
  <div className="group/heading flex h-6 items-center pr-1 pl-2 pointer-coarse:h-11">
    <h2 id={id} className="flex-1 text-2xs font-medium text-text-faint">
      {children}
    </h2>
    {action}
  </div>
);

/** Which edge of a team section the drop line is drawn on, if either. */
type DropEdge = 'before' | 'after' | null;

/** The id of a team's toggle, so a keyboard move can keep focus on it. */
const toggleId = (teamId: string): string => `team-toggle-${teamId}`;

/** Props for TeamSection: one team and whether its surfaces are showing. */
interface TeamSectionProps {
  slug: string;
  team: TeamRead;
  isOpen: boolean;
  onToggle: () => void;
  onNavigate?: (() => void) | undefined;
  pathname: string;
  /** True while the projects list is filtered to this team. */
  isProjectsActive: boolean;
  /** How many issues wait in the team's triage inbox, or null when triage is off. */
  triageCount: number | null;
  index: number;
  count: number;
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
}

/**
 * One team in the sidebar, expanding to the surfaces that belong to it, with
 * a menu of the team's own actions that shows on hover or focus. The section
 * drags by its header to a new place, Alt with an arrow key moves it from the
 * keyboard, and the menu offers the same moves for a touch screen.
 */
const TeamSection: React.FC<TeamSectionProps> = ({
  slug,
  team,
  isOpen,
  onToggle,
  onNavigate,
  pathname,
  isProjectsActive,
  triageCount,
  index,
  count,
  canReorder,
  dragging,
  dropEdge,
  onMove,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}) => {
  const panelId = `team-nav-${team.id}`;
  const home = teamPath(slug, team.key_prefix);
  const issuesActive =
    pathname === home || pathname === teamBoardPath(slug, team.key_prefix);

  return (
    <div
      className={cn('group/team relative', dragging && 'opacity-50')}
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
          if (event.key === 'ArrowUp' && index > 0) {
            event.preventDefault();
            onMove(index - 1);
          }
          if (event.key === 'ArrowDown' && index < count - 1) {
            event.preventDefault();
            onMove(index + 1);
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
        <span className="min-w-0 truncate text-left font-medium">
          {team.name}
        </span>
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
        {canReorder && <MenuSeparator />}
        {canReorder && index > 0 && (
          <MenuItem
            onSelect={() => {
              onMove(index - 1);
            }}
          >
            Move up
          </MenuItem>
        )}
        {canReorder && index < count - 1 && (
          <MenuItem
            onSelect={() => {
              onMove(index + 1);
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
      </div>
    </div>
  );
};

/**
 * The workspace navigation column. A team section is open when it was toggled
 * open, or when the current route is inside it, which is derived from the route
 * rather than stored so that navigating never has to write state back.
 */
export const Sidebar: React.FC<SidebarProps> = ({ workspace, onNavigate }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const createIssue = useCreateIssue();
  const createTeam = useCreateTeam();
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

  const views = useOwnViews(workspace.id);
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
      applyTeamOrder(
        (teams ?? []).filter(
          (team) => team.private !== true || team.is_member === true
        ),
        pendingOrder
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
    return index < dragFrom ? 'before' : 'after';
  };
  const ownViews = useMemo(() => (views ?? []).slice(0, VIEW_LIMIT), [views]);

  return (
    <div className="flex h-full flex-col bg-surface">
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
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
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
          <MenuItem to={ALL_WORKSPACES_PATH}>All workspaces</MenuItem>
          <MenuItem to="/security">Account security</MenuItem>
          <MenuSeparator />
          <MenuItem to={PRIVACY_PATH}>Privacy Policy</MenuItem>
          <MenuItem to={TERMS_PATH}>Terms of Service</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => void logout()}>Sign out</MenuItem>
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
            label="Create issue"
            size="sm"
            variant="secondary"
            onClick={() => {
              onNavigate?.();
              createIssue.open();
            }}
          >
            <LuSquarePen className="h-3.5 w-3.5" />
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
        className="group/nav min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-2 py-1 scrollbar-thin"
      >
        <div className="space-y-px">
          <NavLink
            to={workspacePath(slug)}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuHouse className={ICON} aria-hidden="true" />
            Home
          </NavLink>
          <NavLink
            to={inboxPath(slug)}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuInbox className={ICON} aria-hidden="true" />
            <span className="flex-1">Inbox</span>
            <InboxBadge workspaceId={workspace.id} />
          </NavLink>
          <NavLink
            to={myIssuesPath(slug)}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuUserRound className={ICON} aria-hidden="true" />
            My issues
          </NavLink>
        </div>

        <section aria-labelledby="sidebar-workspace">
          <SectionHeading id="sidebar-workspace">Workspace</SectionHeading>
          <div className="space-y-px">
            <Link
              to={projectsPath(slug)}
              className={itemClass({ isActive: allProjectsActive })}
              aria-current={allProjectsActive ? 'page' : undefined}
              onClick={onNavigate}
            >
              <LuTarget className={ICON} aria-hidden="true" />
              Projects
            </Link>
            {workspace.role !== 'guest' && (
              <NavLink
                to={initiativesPath(slug)}
                className={itemClass}
                onClick={onNavigate}
              >
                <LuGoal className={ICON} aria-hidden="true" />
                Initiatives
              </NavLink>
            )}
            <NavLink
              to={viewsPath(slug)}
              end
              className={itemClass}
              onClick={onNavigate}
            >
              <LuLayers className={ICON} aria-hidden="true" />
              Views
            </NavLink>
            <NavLink
              to={roadmapPath(slug)}
              end
              className={itemClass}
              onClick={onNavigate}
            >
              <LuMap className={ICON} aria-hidden="true" />
              Roadmap
            </NavLink>
          </div>
        </section>

        {ownViews.length > 0 && (
          <section aria-labelledby="sidebar-views">
            <SectionHeading id="sidebar-views">Your views</SectionHeading>
            <div className="space-y-px">
              {ownViews.map((view) => (
                <NavLink
                  key={view.view_id}
                  to={viewPath(slug, view.view_id)}
                  end
                  className={itemClass}
                  onClick={onNavigate}
                >
                  <LuLayers
                    className="h-3.5 w-3.5 shrink-0 text-text-faint"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{view.name}</span>
                </NavLink>
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="sidebar-teams">
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
            {rows.map((team, index) => (
              <TeamSection
                key={team.id}
                slug={slug}
                team={team}
                isOpen={
                  expanded.includes(team.key_prefix) ||
                  team.key_prefix === prefix
                }
                onToggle={() => {
                  toggle(team.key_prefix);
                }}
                onNavigate={onNavigate}
                pathname={location.pathname}
                isProjectsActive={projectsTeam === team.key_prefix}
                triageCount={triageCounts.get(team.id) ?? null}
                index={index}
                count={rows.length}
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
                onDrop={() => {
                  if (dragFrom !== null) moveTo(dragFrom, index, false);
                  endDrag();
                }}
              />
            ))}
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
              <p className="px-2 py-1 text-xs text-text-faint">No teams yet.</p>
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
      </nav>

      <div className="flex h-topbar items-center gap-1 border-t border-line px-2">
        {user !== null && (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1 text-xs text-text-muted">
            <Avatar
              name={user.display_name ?? user.email}
              src={user.avatar_url}
              size="sm"
            />
            <span className="truncate">{user.display_name ?? user.email}</span>
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
