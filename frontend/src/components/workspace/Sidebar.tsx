/**
 * The workspace sidebar: the workspace switcher at the top, the places that
 * span the whole workspace beneath it, then a section per team the caller can
 * see, each expanding to that team's own surfaces. Rendered as the fixed rail
 * on wide screens and inside a drawer on phones.
 *
 * A team section expands rather than the sidebar changing shape with the
 * route, so the caller keeps sight of the other teams while working inside
 * one. Which sections are open is remembered per workspace, because the set a
 * person cares about is stable and re-opening them on every visit is work the
 * interface can do for them.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuChevronRight,
  LuChevronsUpDown,
  LuInbox,
  LuLayers,
  LuList,
  LuLogOut,
  LuMap,
  LuSearch,
  LuSquareKanban,
  LuTarget,
  LuUserRound,
} from 'react-icons/lu';
import { Link, NavLink, useLocation, useParams } from 'react-router-dom';
import { listTeams } from '../../api/teams';
import { useAuth } from '../../hooks/useAuth';
import { canManageMembers } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { teamsKey } from '../../lib/queryKeys';
import {
  inboxPath,
  myIssuesPath,
  projectsPath,
  roadmapPath,
  searchPath,
  settingsPath,
  teamBoardPath,
  teamCyclesPath,
  teamPath,
} from '../../lib/paths';
import { Logo } from '../../brand';
import type { TeamRead, WorkspaceRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import ThemeToggle from '../ui/theme-toggle';
import InboxBadge from '../views/InboxBadge';

/** Props for Sidebar: the workspace and what to do when a link is followed. */
export interface SidebarProps {
  workspace: WorkspaceRead;
  /** Called after any link is followed, so a drawer can close. */
  onNavigate?: () => void;
}

/** How often the team list is re-read while the sidebar is mounted. */
const POLL_MS = 60000;

const ICON = 'h-4 w-4 shrink-0';
const SUB_ICON = 'h-3.5 w-3.5 shrink-0';

const itemClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    'flex h-7 items-center gap-2 rounded-sm px-2 text-sm transition-colors duration-100',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
    isActive
      ? 'bg-raised font-medium text-text'
      : 'text-text-muted hover:bg-raised/70 hover:text-text'
  );

const subItemClass = ({ isActive }: { isActive: boolean }): string =>
  cn(
    'flex h-7 items-center gap-2 rounded-sm pr-2 pl-7 text-sm transition-colors duration-100',
    'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
    isActive
      ? 'bg-raised font-medium text-text'
      : 'text-text-muted hover:bg-raised/70 hover:text-text'
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

/** The key prefix the current route is inside, from a team or an issue key. */
const currentPrefix = (params: {
  keyPrefix?: string;
  key?: string;
}): string | null => {
  if (params.keyPrefix !== undefined) return params.keyPrefix;
  if (params.key !== undefined) return params.key.split('-')[0] ?? null;
  return null;
};

/** Props for TeamSection: one team and whether its surfaces are showing. */
interface TeamSectionProps {
  slug: string;
  team: TeamRead;
  isOpen: boolean;
  onToggle: () => void;
  onNavigate?: (() => void) | undefined;
  /** True while the projects list is filtered to this team. */
  isProjectsActive: boolean;
}

/** One team in the sidebar, expanding to the surfaces that belong to it. */
const TeamSection: React.FC<TeamSectionProps> = ({
  slug,
  team,
  isOpen,
  onToggle,
  onNavigate,
  isProjectsActive,
}) => {
  const panelId = `team-nav-${team.id}`;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className={cn(
          'flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-sm transition-colors duration-100',
          'text-text-muted hover:bg-raised/70 hover:text-text',
          'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none'
        )}
      >
        <LuChevronRight
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-faint transition-transform duration-100',
            isOpen && 'rotate-90'
          )}
        />
        <Avatar
          name={team.name}
          size="sm"
          className="h-4 w-4 rounded-xs text-2xs"
        />
        <span className="min-w-0 flex-1 truncate text-left font-medium">
          {team.name}
        </span>
        <span className="shrink-0 font-mono text-2xs text-text-faint">
          {team.key_prefix}
        </span>
      </button>

      {isOpen && (
        <div id={panelId} className="mt-px space-y-px">
          <NavLink
            to={teamPath(slug, team.key_prefix)}
            end
            className={subItemClass}
            onClick={onNavigate}
          >
            <LuList className={SUB_ICON} aria-hidden="true" />
            Issues
          </NavLink>
          <NavLink
            to={teamBoardPath(slug, team.key_prefix)}
            end
            className={subItemClass}
            onClick={onNavigate}
          >
            <LuSquareKanban className={SUB_ICON} aria-hidden="true" />
            Board
          </NavLink>
          <NavLink
            to={teamCyclesPath(slug, team.key_prefix)}
            end
            className={subItemClass}
            onClick={onNavigate}
          >
            <LuLayers className={SUB_ICON} aria-hidden="true" />
            Cycles
          </NavLink>
          <Link
            to={`${projectsPath(slug)}?team=${encodeURIComponent(team.key_prefix)}`}
            className={subItemClass({ isActive: isProjectsActive })}
            aria-current={isProjectsActive ? 'page' : undefined}
            onClick={onNavigate}
          >
            <LuTarget className={SUB_ICON} aria-hidden="true" />
            Projects
          </Link>
        </div>
      )}
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
  const auth = useQueryAuth();
  const params = useParams<{ keyPrefix?: string; key?: string }>();
  const location = useLocation();
  const onProjectsPage = location.pathname.startsWith(
    projectsPath(workspace.slug)
  );
  const projectsTeam = onProjectsPage
    ? new URLSearchParams(location.search).get('team')
    : null;
  const allProjectsActive = onProjectsPage && projectsTeam === null;
  const prefix = currentPrefix(params) ?? projectsTeam;

  const [expanded, setExpanded] = useState<string[]>(() =>
    readExpanded(workspace.id)
  );

  const { data: teams } = usePolledQuery(
    ({ signal }) => listTeams(workspace.id, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspace.id !== '',
      queryKey: teamsKey(workspace.id),
      auth,
    }
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

  const rows = useMemo(() => teams ?? [], [teams]);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-topbar items-center px-2">
        <Menu
          label="Workspace"
          className="min-w-0 flex-1"
          trigger={(props) => (
            <button
              type="button"
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm font-semibold hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
              {...props}
            >
              <Logo size={18} title={null} />
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              <LuChevronsUpDown
                className="h-3.5 w-3.5 shrink-0 text-text-faint"
                aria-hidden="true"
              />
            </button>
          )}
        >
          <MenuItem
            to={
              canManageMembers(workspace.role)
                ? settingsPath(workspace.slug)
                : `${settingsPath(workspace.slug)}/api-keys`
            }
          >
            Workspace settings
          </MenuItem>
          <MenuItem to="/workspaces">All workspaces</MenuItem>
          <MenuItem to="/security">Account security</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => void logout()}>Sign out</MenuItem>
        </Menu>
      </div>

      <nav
        aria-label="Workspace"
        className="flex-1 space-y-4 overflow-y-auto px-2 py-1 scrollbar-thin"
      >
        <div className="space-y-px">
          <NavLink
            to={inboxPath(workspace.slug)}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuInbox className={ICON} aria-hidden="true" />
            <span className="flex-1">Inbox</span>
            <InboxBadge workspaceId={workspace.id} />
          </NavLink>
          <NavLink
            to={myIssuesPath(workspace.slug)}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuUserRound className={ICON} aria-hidden="true" />
            My issues
          </NavLink>
          <Link
            to={projectsPath(workspace.slug)}
            className={itemClass({ isActive: allProjectsActive })}
            aria-current={allProjectsActive ? 'page' : undefined}
            onClick={onNavigate}
          >
            <LuTarget className={ICON} aria-hidden="true" />
            Projects
          </Link>
          <NavLink
            to={roadmapPath(workspace.slug)}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuMap className={ICON} aria-hidden="true" />
            Roadmap
          </NavLink>
          <NavLink
            to={searchPath(workspace.slug)}
            end
            className={itemClass}
            onClick={onNavigate}
          >
            <LuSearch className={ICON} aria-hidden="true" />
            Search
          </NavLink>
        </div>

        <div>
          <p className="px-2 pb-1 text-2xs font-medium text-text-faint">
            Teams
          </p>
          <div className="space-y-px">
            {rows.length === 0 ? (
              <p className="px-2 py-1 text-xs text-text-faint">No teams yet.</p>
            ) : (
              rows.map((team) => (
                <TeamSection
                  key={team.id}
                  slug={workspace.slug}
                  team={team}
                  isOpen={
                    expanded.includes(team.key_prefix) ||
                    team.key_prefix === prefix
                  }
                  onToggle={() => {
                    toggle(team.key_prefix);
                  }}
                  onNavigate={onNavigate}
                  isProjectsActive={projectsTeam === team.key_prefix}
                />
              ))
            )}
          </div>
        </div>
      </nav>

      <div className="flex h-topbar items-center gap-1 border-t border-line px-2">
        {user !== null && (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1 text-xs text-text-muted">
            <Avatar name={user.display_name ?? user.email} size="sm" />
            <span className="truncate">{user.display_name ?? user.email}</span>
          </span>
        )}
        <ThemeToggle />
        <IconButton
          label="Sign out"
          size="sm"
          onClick={() => void logout()}
          data-testid="sidebar-sign-out"
        >
          <LuLogOut className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
};

export default Sidebar;
